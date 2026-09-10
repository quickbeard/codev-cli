import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { claudeNativeBinaryMissing } from "@/lib/npm.js";
import { agentOnPath, runAgent, spawner } from "@/lib/run.js";

// Stub the native-binary probe so the runtime repair hint can be exercised
// without a real npm-global Claude Code install. Defaults to "present" so
// existing tests that launch `node` (or other agents) never see the hint.
vi.mock("@/lib/npm.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/npm.js")>();
	return {
		...actual,
		claudeNativeBinaryMissing: vi.fn().mockResolvedValue(false),
	};
});

let tempDir: string;
let errorSpy: MockInstance;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-run-test-"));
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	// Clear call history + the mockResolvedValueOnce queue, then restore the
	// "binary present" default so per-test assertions start from a clean slate.
	vi.mocked(claudeNativeBinaryMissing).mockReset().mockResolvedValue(false);
});

afterEach(() => {
	errorSpy.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("runAgent", () => {
	test("returns 0 when child exits cleanly", async () => {
		// `0` (a no-op expression) instead of `""` — runAgent uses shell:true and
		// cmd.exe drops empty-string args, leaving Node with a bare `-e` and no
		// script (which errors out with `node: -e requires an argument`).
		expect(await runAgent("node", ["-e", "0"])).toBe(0);
	});

	test("returns the child's non-zero exit code", async () => {
		expect(await runAgent("node", ["-e", "process.exit(7)"])).toBe(7);
	});

	test("forwards args verbatim to the child", async () => {
		// Write the script to a file rather than passing it via `-e`. runAgent
		// uses shell:true, and on Windows cmd.exe re-parses the joined command
		// line — quotes/backslashes inside the inline script get mangled, and
		// arguments containing spaces are split at the spaces.
		const outPath = join(tempDir, "argv.json");
		const scriptPath = join(tempDir, "script.js");
		writeFileSync(
			scriptPath,
			// slice(2) drops argv[0] (node) and argv[1] (the script path) so we
			// only capture the user-forwarded args.
			`require('fs').writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(process.argv.slice(2)))`,
		);
		const code = await runAgent("node", [
			scriptPath,
			"hello",
			"--flag",
			"world",
		]);
		expect(code).toBe(0);
		const captured = JSON.parse(readFileSync(outPath, "utf-8"));
		expect(captured).toEqual(["hello", "--flag", "world"]);
	});

	// Skipped on Windows: with shell:true, cmd.exe handles "command not
	// recognized" itself and the child emits a non-zero exit instead of the
	// ENOENT error event that drives runAgent's friendly install hint.
	test.skipIf(process.platform === "win32")(
		"returns 1 and prints install hint on ENOENT",
		async () => {
			const code = await runAgent("codev-nonexistent-binary-xyzzy-12345", []);
			expect(code).toBe(1);
			const messages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
			expect(
				messages.some((m: string) =>
					m.includes(
						"could not be launched. If it isn't installed, run 'codevhub install'",
					),
				),
			).toBe(true);
		},
	);

	// Skipped on Windows: there are no real UNIX signals — `process.kill(pid,
	// 'SIGTERM')` calls TerminateProcess and the child exits with code 1, not
	// signal death. The 128+signo mapping is a POSIX-only contract.
	test.skipIf(process.platform === "win32")(
		"maps signal death to 128 + signo",
		async () => {
			const code = await runAgent("node", [
				"-e",
				"process.kill(process.pid,'SIGTERM')",
			]);
			expect(code).toBe(128 + constants.signals.SIGTERM);
		},
	);

	// A fake child that never emits "exit" stands in for a wedged launch chain
	// (on Windows, a cmd.exe shim sitting at "Terminate batch job (Y/N)?").
	// `process.emit` invokes our listeners without asking the OS for a real
	// signal, so these run identically on Windows.
	function withWedgedChild(): {
		child: ChildProcess;
		restore: () => void;
		stderr: string[];
	} {
		const child = new EventEmitter() as unknown as ChildProcess;
		const spawnSpy = vi
			.spyOn(spawner, "spawn")
			.mockImplementation((() => child) as unknown as typeof spawner.spawn);
		const original = process.stderr.write.bind(process.stderr);
		const stderr: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stderr.write;
		return {
			child,
			stderr,
			restore: () => {
				process.stderr.write = original;
				spawnSpy.mockRestore();
			},
		};
	}

	test("swallows a single interrupt so the child can clean up", async () => {
		const { child, restore } = withWedgedChild();
		try {
			const pending = runAgent("codev", []);
			process.emit("SIGINT");
			await new Promise((r) => setImmediate(r));
			// Still waiting: the child's own exit code wins, not the interrupt.
			child.emit("exit", 0, null);
			expect(await pending).toBe(0);
		} finally {
			restore();
		}
	});

	test("stops waiting for a wedged child after a second interrupt", async () => {
		const { restore, stderr } = withWedgedChild();
		try {
			const pending = runAgent("codev", []);
			process.emit("SIGINT");
			await new Promise((r) => setImmediate(r));
			process.emit("SIGINT");
			expect(await pending).toBe(130);
			expect(
				stderr.some((m) => m.includes("Stopped waiting for CoDev Code")),
			).toBe(true);
		} finally {
			restore();
		}
	});

	test("removes its signal listeners once it stops waiting", async () => {
		const before = process.listenerCount("SIGINT");
		const { restore } = withWedgedChild();
		try {
			const pending = runAgent("codev", []);
			process.emit("SIGINT");
			await new Promise((r) => setImmediate(r));
			process.emit("SIGINT");
			await pending;
			expect(process.listenerCount("SIGINT")).toBe(before);
		} finally {
			restore();
		}
	});

	test("prints a startup banner to stderr before launching", async () => {
		// vi.spyOn(process.stderr, 'write') doesn't reliably intercept under
		// vitest's stdio handling, so swap the method directly. stdio:'inherit'
		// wires the child to the parent's stderr fd, not through this method,
		// so we only capture our own banner write.
		const original = process.stderr.write.bind(process.stderr);
		const calls: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			calls.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stderr.write;
		try {
			await runAgent("node", ["-e", ""]);
		} finally {
			process.stderr.write = original;
		}
		// Unknown commands fall back to the bare cmd as their label.
		expect(calls.some((m) => m.includes("Starting node..."))).toBe(true);
	});

	test("uses the friendly product label for known agents", async () => {
		// Stub spawn so we don't launch a real `claude` binary on dev machines
		// that have Claude Code installed — its stdin handshake would otherwise
		// hang the test for ~3s (and intermittently exceed the 5s timeout under
		// full-suite parallelism). The banner write fires before spawn, so
		// returning a fake child that immediately emits `exit(0)` is enough.
		const fakeChild = new EventEmitter() as unknown as ChildProcess;
		const spawnSpy = vi.spyOn(spawner, "spawn").mockImplementation(((
			..._args: unknown[]
		) => {
			queueMicrotask(() => fakeChild.emit("exit", 0, null));
			return fakeChild;
		}) as unknown as typeof spawner.spawn);

		const original = process.stderr.write.bind(process.stderr);
		const calls: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			calls.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stderr.write;
		try {
			await runAgent("claude", []);
		} finally {
			process.stderr.write = original;
			spawnSpy.mockRestore();
		}
		expect(calls.some((m) => m.includes("Starting Claude Code..."))).toBe(true);
	});

	// Stub spawn to emit a chosen exit code without launching a real binary,
	// and capture our own stderr writes (stdio:'inherit' bypasses this method,
	// so we only see codev's banner + repair hint).
	function runWithFakeExit(
		cmd: string,
		exitCode: number,
	): Promise<{ code: number; stderr: string[] }> {
		const fakeChild = new EventEmitter() as unknown as ChildProcess;
		const spawnSpy = vi.spyOn(spawner, "spawn").mockImplementation(((
			..._args: unknown[]
		) => {
			queueMicrotask(() => fakeChild.emit("exit", exitCode, null));
			return fakeChild;
		}) as unknown as typeof spawner.spawn);

		const original = process.stderr.write.bind(process.stderr);
		const stderr: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stderr.write;

		return runAgent(cmd, [])
			.then((code) => ({ code, stderr }))
			.finally(() => {
				process.stderr.write = original;
				spawnSpy.mockRestore();
			});
	}

	test("prints native-binary repair hint when claude exits non-zero and binary is missing", async () => {
		vi.mocked(claudeNativeBinaryMissing).mockResolvedValueOnce(true);
		const { code, stderr } = await runWithFakeExit("claude", 1);
		expect(code).toBe(1);
		expect(stderr.some((m) => m.includes("native binary is missing"))).toBe(
			true,
		);
		expect(stderr.some((m) => m.includes("codevhub install"))).toBe(true);
	});

	test("stays quiet when claude exits non-zero but the binary is present", async () => {
		vi.mocked(claudeNativeBinaryMissing).mockResolvedValueOnce(false);
		const { code, stderr } = await runWithFakeExit("claude", 1);
		expect(code).toBe(1);
		expect(stderr.some((m) => m.includes("native binary is missing"))).toBe(
			false,
		);
	});

	test("does not probe the claude binary on a clean (zero) exit", async () => {
		const { code } = await runWithFakeExit("claude", 0);
		expect(code).toBe(0);
		expect(claudeNativeBinaryMissing).not.toHaveBeenCalled();
	});

	test("does not probe for non-claude agents that exit non-zero", async () => {
		const { code } = await runWithFakeExit("codex", 1);
		expect(code).toBe(1);
		expect(claudeNativeBinaryMissing).not.toHaveBeenCalled();
	});

	// Capture the env runAgent hands to spawn. The options bag is always the
	// last argument (3rd on POSIX, 2nd in the Windows single-string form).
	function runCapturingEnv(
		cmd: string,
	): Promise<NodeJS.ProcessEnv | undefined> {
		const fakeChild = new EventEmitter() as unknown as ChildProcess;
		let env: NodeJS.ProcessEnv | undefined;
		const spawnSpy = vi.spyOn(spawner, "spawn").mockImplementation(((
			...args: unknown[]
		) => {
			env = (args[args.length - 1] as { env?: NodeJS.ProcessEnv }).env;
			queueMicrotask(() => fakeChild.emit("exit", 0, null));
			return fakeChild;
		}) as unknown as typeof spawner.spawn);

		return runAgent(cmd, [])
			.then(() => env)
			.finally(() => {
				spawnSpy.mockRestore();
			});
	}

	test("disables CoDev Code's self-updater via CODEV_DISABLE_AUTOUPDATE", async () => {
		// The hub owns updates (`codevhub update`), so every launch of the agent
		// must pin the kill switch on its own updater. The fork reads the
		// CODEV_-prefixed flag (it renamed every OPENCODE_* env var); the old
		// spelling rides along for builds that predate the rename.
		const env = await runCapturingEnv("codev");
		expect(env?.CODEV_DISABLE_AUTOUPDATE).toBe("1");
		expect(env?.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
	});

	test("does not set the autoupdate kill switch for the other agents", async () => {
		// Guard against the parent process's own env leaking into the assertion.
		vi.stubEnv("CODEV_DISABLE_AUTOUPDATE", undefined);
		vi.stubEnv("OPENCODE_DISABLE_AUTOUPDATE", undefined);
		try {
			for (const cmd of ["opencode", "claude", "codex"]) {
				const env = await runCapturingEnv(cmd);
				expect(env?.CODEV_DISABLE_AUTOUPDATE).toBeUndefined();
				expect(env?.OPENCODE_DISABLE_AUTOUPDATE).toBeUndefined();
			}
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("agentOnPath", () => {
	test("finds an executable that is on PATH", () => {
		// The test runner itself is a node process, so `node` (node.exe's
		// resolution goes through PATHEXT on Windows) must be findable.
		expect(agentOnPath("node")).toBe(true);
	});

	test("returns false for a binary that does not exist", () => {
		expect(agentOnPath("codev-definitely-not-installed-xyzzy")).toBe(false);
	});
});
