import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import {
	detectInstalledViaNpm,
	installAndVerify,
	installPackage,
	npmGlobalRoot,
	verifyInstall,
} from "@/npm.js";

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

interface ExecCall {
	file: string;
	args: string[];
}

interface StubOptions {
	handler: (
		file: string,
		args: string[],
	) => {
		error?: Error | null;
		stdout?: string;
		stderr?: string;
	};
}

function stubExecFile(opts: StubOptions): ExecCall[] {
	const calls: ExecCall[] = [];
	spyOn(child_process, "execFile").mockImplementation(((
		file: string,
		args: string[],
		...rest: unknown[]
	) => {
		calls.push({ file, args });
		const cb = rest[rest.length - 1] as ExecCb;
		const r = opts.handler(file, args);
		setImmediate(() => cb(r.error ?? null, r.stdout ?? "", r.stderr ?? ""));
		return {} as unknown as child_process.ChildProcess;
	}) as unknown as typeof child_process.execFile);
	return calls;
}

afterEach(() => {
	// bun's spyOn carries across tests in the same file; restore all mocks.
	// biome-ignore lint/suspicious/noExplicitAny: test cleanup
	(spyOn as any).mockRestore?.();
});

describe("npm.ts", () => {
	describe("installPackage", () => {
		test("runs npm install -g with expected flags", async () => {
			const calls = stubExecFile({ handler: () => ({ stdout: "ok" }) });
			const err = await installPackage("some-pkg");
			expect(err).toBeNull();
			expect(calls.length).toBe(1);
			expect(calls[0]?.file).toBe("npm");
			expect(calls[0]?.args).toEqual([
				"install",
				"-g",
				"some-pkg",
				"--include=optional",
				"--foreground-scripts",
			]);
		});

		test("returns stderr on failure", async () => {
			stubExecFile({
				handler: () => ({
					error: new Error("exit 1"),
					stderr: "npm: permission denied\n",
				}),
			});
			const err = await installPackage("some-pkg");
			expect(err).toBe("npm: permission denied");
		});

		test("falls back to error message if stderr empty", async () => {
			stubExecFile({
				handler: () => ({ error: new Error("spawn npm ENOENT") }),
			});
			const err = await installPackage("some-pkg");
			expect(err).toBe("spawn npm ENOENT");
		});
	});

	describe("npmGlobalRoot", () => {
		test("returns trimmed stdout on success", async () => {
			stubExecFile({
				handler: () => ({ stdout: "/usr/local/lib/node_modules\n" }),
			});
			const root = await npmGlobalRoot();
			expect(root).toBe("/usr/local/lib/node_modules");
		});

		test("returns null on error", async () => {
			stubExecFile({ handler: () => ({ error: new Error("boom") }) });
			const root = await npmGlobalRoot();
			expect(root).toBeNull();
		});

		test("returns null for empty output", async () => {
			stubExecFile({ handler: () => ({ stdout: "   \n" }) });
			const root = await npmGlobalRoot();
			expect(root).toBeNull();
		});
	});

	describe("verifyInstall", () => {
		test("invokes the CLI binary with --version", async () => {
			const calls = stubExecFile({ handler: () => ({ stdout: "1.0.0" }) });
			const err = await verifyInstall("claude-code");
			expect(err).toBeNull();
			expect(calls[0]?.file).toBe("claude");
			expect(calls[0]?.args).toEqual(["--version"]);
		});

		test("uses 'opencode' binary for opencode tool", async () => {
			const calls = stubExecFile({ handler: () => ({ stdout: "1.0.0" }) });
			await verifyInstall("opencode");
			expect(calls[0]?.file).toBe("opencode");
		});

		test("returns an error string on failure", async () => {
			stubExecFile({
				handler: () => ({
					error: new Error("spawn claude ENOENT"),
					stderr: "",
				}),
			});
			const err = await verifyInstall("claude-code");
			expect(err).toBe("spawn claude ENOENT");
		});
	});

	describe("installAndVerify", () => {
		test("returns null on happy path", async () => {
			stubExecFile({ handler: () => ({ stdout: "ok" }) });
			const err = await installAndVerify("opencode");
			expect(err).toBeNull();
		});

		test("returns install error when npm install fails", async () => {
			stubExecFile({
				handler: (file, args) => {
					if (file === "npm" && args[0] === "install") {
						return { error: new Error("x"), stderr: "disk full" };
					}
					return { stdout: "1.0.0" };
				},
			});
			const err = await installAndVerify("opencode");
			expect(err).toBe("disk full");
		});

		test("opencode: returns verify error if CLI fails post-install", async () => {
			stubExecFile({
				handler: (file) => {
					if (file === "npm") return { stdout: "ok" };
					// opencode --version fails
					return { error: new Error("nope"), stderr: "cannot run" };
				},
			});
			const err = await installAndVerify("opencode");
			expect(err).toContain("installed but 'opencode' fails");
			expect(err).toContain("cannot run");
		});

		test("claude-code: runs postinstall recovery and re-verifies", async () => {
			let claudeCalls = 0;
			const existsSpy = spyOn(fs, "existsSync").mockImplementation(() => true);
			stubExecFile({
				handler: (file, args) => {
					if (file === "npm" && args[0] === "install") return { stdout: "ok" };
					if (file === "npm" && args[0] === "root") {
						return { stdout: "/fake/root" };
					}
					if (file === "claude") {
						claudeCalls += 1;
						// First call fails; second (after postinstall) succeeds.
						if (claudeCalls === 1) {
							return { error: new Error("missing binary"), stderr: "oops" };
						}
						return { stdout: "1.0.0" };
					}
					if (file === "node") return { stdout: "postinstall ok" };
					return { stdout: "" };
				},
			});
			const err = await installAndVerify("claude-code");
			expect(err).toBeNull();
			expect(claudeCalls).toBe(2);
			existsSpy.mockRestore();
		});

		test("claude-code: reports postinstall-recovery failure", async () => {
			const existsSpy = spyOn(fs, "existsSync").mockImplementation(() => true);
			stubExecFile({
				handler: (file, args) => {
					if (file === "npm" && args[0] === "install") return { stdout: "ok" };
					if (file === "npm" && args[0] === "root") {
						return { stdout: "/fake/root" };
					}
					if (file === "claude") {
						return { error: new Error("missing binary"), stderr: "oops" };
					}
					if (file === "node") {
						return { error: new Error("x"), stderr: "postinstall failed" };
					}
					return { stdout: "" };
				},
			});
			const err = await installAndVerify("claude-code");
			expect(err).toContain("postinstall recovery failed: postinstall failed");
			existsSpy.mockRestore();
		});

		describe("codex windows recovery", () => {
			function withWin32<T>(
				arch: "x64" | "arm64",
				fn: () => Promise<T> | T,
			): Promise<T> {
				const origPlatform = process.platform;
				const origArch = process.arch;
				Object.defineProperty(process, "platform", {
					value: "win32",
					configurable: true,
				});
				Object.defineProperty(process, "arch", {
					value: arch,
					configurable: true,
				});
				return Promise.resolve()
					.then(fn)
					.finally(() => {
						Object.defineProperty(process, "platform", {
							value: origPlatform,
							configurable: true,
						});
						Object.defineProperty(process, "arch", {
							value: origArch,
							configurable: true,
						});
					});
			}

			test("codex: returns null when first install + verify succeed (no recovery)", async () => {
				await withWin32("x64", async () => {
					const calls = stubExecFile({ handler: () => ({ stdout: "ok" }) });
					const err = await installAndVerify("codex");
					expect(err).toBeNull();
					// 1x install + 1x verify, no recovery
					expect(calls.length).toBe(2);
					expect(calls.some((c) => c.args.includes("view"))).toBe(false);
				});
			});

			test("codex: runs Windows recovery on x64 and re-verifies", async () => {
				await withWin32("x64", async () => {
					let codexCalls = 0;
					const calls = stubExecFile({
						handler: (file, args) => {
							if (
								file === "npm" &&
								args[0] === "install" &&
								args[2] === "@openai/codex"
							) {
								return { stdout: "ok" };
							}
							if (file === "npm" && args[0] === "view") {
								return { stdout: "0.125.0\n" };
							}
							if (
								file === "npm" &&
								args[0] === "install" &&
								args.some((a) => a.startsWith("@openai/codex@"))
							) {
								return { stdout: "ok" };
							}
							if (file === "codex") {
								codexCalls += 1;
								if (codexCalls === 1) {
									return {
										error: new Error("missing native"),
										stderr: "Missing optional dependency",
									};
								}
								return { stdout: "0.125.0" };
							}
							return { stdout: "" };
						},
					});

					const err = await installAndVerify("codex");
					expect(err).toBeNull();
					expect(codexCalls).toBe(2);

					const recoveryCall = calls.find(
						(c) =>
							c.file === "npm" &&
							c.args[0] === "install" &&
							c.args.some((a) => a.startsWith("@openai/codex@")),
					);
					expect(recoveryCall).toBeDefined();
					expect(recoveryCall?.args).toEqual([
						"install",
						"-g",
						"@openai/codex@0.125.0",
						"@openai/codex-win32-x64@npm:@openai/codex@0.125.0-win32-x64",
					]);
				});
			});

			test("codex: targets win32-arm64 alias on arm64 hosts", async () => {
				await withWin32("arm64", async () => {
					let codexCalls = 0;
					const calls = stubExecFile({
						handler: (file, args) => {
							if (file === "npm" && args[0] === "view") {
								return { stdout: "0.125.0" };
							}
							if (file === "codex") {
								codexCalls += 1;
								if (codexCalls === 1) {
									return { error: new Error("missing"), stderr: "" };
								}
								return { stdout: "0.125.0" };
							}
							return { stdout: "ok" };
						},
					});

					const err = await installAndVerify("codex");
					expect(err).toBeNull();

					const recoveryCall = calls.find(
						(c) =>
							c.file === "npm" &&
							c.args[0] === "install" &&
							c.args.some((a) => a.includes("win32-arm64")),
					);
					expect(recoveryCall?.args).toContain(
						"@openai/codex-win32-arm64@npm:@openai/codex@0.125.0-win32-arm64",
					);
				});
			});

			test("codex: surfaces recovery failure when npm view errors", async () => {
				await withWin32("x64", async () => {
					stubExecFile({
						handler: (file, args) => {
							if (file === "npm" && args[0] === "install") {
								return { stdout: "ok" };
							}
							if (file === "npm" && args[0] === "view") {
								return {
									error: new Error("offline"),
									stderr: "ENOTFOUND registry.npmjs.org",
								};
							}
							if (file === "codex") {
								return { error: new Error("missing"), stderr: "missing" };
							}
							return { stdout: "" };
						},
					});

					const err = await installAndVerify("codex");
					expect(err).toContain("Windows recovery failed");
					expect(err).toContain("npm view @openai/codex version failed");
				});
			});

			test("codex: surfaces verify failure that persists after recovery", async () => {
				await withWin32("x64", async () => {
					stubExecFile({
						handler: (file, args) => {
							if (file === "npm" && args[0] === "view") {
								return { stdout: "0.125.0" };
							}
							if (file === "codex") {
								return { error: new Error("still broken"), stderr: "still" };
							}
							return { stdout: "ok" };
						},
					});

					const err = await installAndVerify("codex");
					expect(err).toContain(
						"installed but 'codex' still fails after Windows recovery",
					);
				});
			});

			test("codex: on non-Windows, verify failure does not trigger recovery", async () => {
				const origPlatform = process.platform;
				Object.defineProperty(process, "platform", {
					value: "linux",
					configurable: true,
				});
				try {
					const calls = stubExecFile({
						handler: (file) => {
							if (file === "codex") {
								return { error: new Error("missing"), stderr: "broken" };
							}
							return { stdout: "ok" };
						},
					});
					const err = await installAndVerify("codex");
					expect(err).toContain("installed but 'codex' fails");
					expect(calls.some((c) => c.args.includes("view"))).toBe(false);
				} finally {
					Object.defineProperty(process, "platform", {
						value: origPlatform,
						configurable: true,
					});
				}
			});
		});
	});

	describe("detectInstalledViaNpm", () => {
		test("returns true when package dir exists under npm root", async () => {
			stubExecFile({ handler: () => ({ stdout: "/fake/root" }) });
			const existsSpy = spyOn(fs, "existsSync").mockImplementation(
				(p: fs.PathLike) =>
					String(p) === "/fake/root/@anthropic-ai/claude-code",
			);
			const got = await detectInstalledViaNpm("claude-code");
			expect(got).toBe(true);
			existsSpy.mockRestore();
		});

		test("returns false when package dir missing", async () => {
			stubExecFile({ handler: () => ({ stdout: "/fake/root" }) });
			const existsSpy = spyOn(fs, "existsSync").mockImplementation(() => false);
			const got = await detectInstalledViaNpm("opencode");
			expect(got).toBe(false);
			existsSpy.mockRestore();
		});

		test("returns false when npm root resolution fails", async () => {
			stubExecFile({ handler: () => ({ error: new Error("boom") }) });
			const got = await detectInstalledViaNpm("opencode");
			expect(got).toBe(false);
		});
	});
});
