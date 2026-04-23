import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as child_process from "node:child_process";
import { cleanup, render } from "ink-testing-library";
import { App } from "@/App.js";
import * as auth from "@/auth.js";
import * as configure from "@/configure.js";
import * as proxy from "@/proxy.js";

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

function stubExecFile(
	handler: (
		file: string,
		args: string[],
	) => {
		error?: Error | null;
		stdout?: string;
		stderr?: string;
	},
) {
	spyOn(child_process, "execFile").mockImplementation(((
		file: string,
		args: string[],
		...rest: unknown[]
	) => {
		const cb = rest[rest.length - 1] as ExecCb;
		const r = handler(file, args);
		setImmediate(() => cb(r.error ?? null, r.stdout ?? "", r.stderr ?? ""));
		return {} as unknown as child_process.ChildProcess;
	}) as unknown as typeof child_process.execFile);
}

async function advanceFromSelectToInstalling(stdin: {
	write: (s: string) => void;
}) {
	// Select Claude Code, confirm selection, accept backup-warning confirm.
	stdin.write(" ");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("y");
	await new Promise((r) => setTimeout(r, 30));
}

// `useApp().exit()` unmounts the tree so the final `lastFrame()` is blank.
// Inspect the full frame history instead to assert what the app did render.
function allFrames(frames: string[]): string {
	return frames.join("\n");
}

afterEach(() => {
	cleanup();
});

describe("App fail-stop invariant", () => {
	test("install failure does not advance to Login step", async () => {
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "install") {
				const err = Object.assign(new Error("spawn npm ENOENT"), {
					code: "ENOENT",
				});
				return { error: err, stderr: "spawn npm ENOENT" };
			}
			return { stdout: "1.0.0" };
		});

		const { stdin, frames } = render(<App />);
		await advanceFromSelectToInstalling(stdin);
		await new Promise((r) => setTimeout(r, 200));

		const history = allFrames(frames);
		expect(history).toContain("Failed to install");
		expect(history).not.toContain("Login to SSO");
		expect(history).not.toContain("Configure tools");
	});

	test("login failure does not advance to Configure step", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		spyOn(auth, "login").mockImplementation(() =>
			Promise.reject(new Error("Connection refused")),
		);

		const { stdin, frames } = render(<App />);
		await advanceFromSelectToInstalling(stdin);
		await new Promise((r) => setTimeout(r, 200));

		const history = allFrames(frames);
		expect(history).toContain("Login to SSO");
		expect(history).toContain("Login failed: Connection refused");
		expect(history).not.toContain("Configure tools");
		expect(history).not.toContain("Happy coding");
	});

	test("configure failure does not reach the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		spyOn(auth, "login").mockImplementation(() =>
			Promise.resolve({
				access_token: "access-xyz",
				id_token: "id-xyz",
				expires_at: Date.now() + 3_600_000,
				user: { sub: "u", email: "test@example.com", displayName: "Test" },
			}),
		);
		spyOn(proxy, "fetchApiKey").mockResolvedValue("sk-test-123");
		spyOn(configure, "configureClaudeCode").mockImplementation(() => {
			throw new Error("disk full");
		});

		const { stdin, frames } = render(<App />);
		await advanceFromSelectToInstalling(stdin);
		await new Promise((r) => setTimeout(r, 300));

		const history = allFrames(frames);
		expect(history).toContain("Configure tools");
		expect(history).toContain("Configure failed: disk full");
		expect(history).not.toContain("Happy coding");
	});

	test("successful flow reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		spyOn(auth, "login").mockImplementation(() =>
			Promise.resolve({
				access_token: "access-xyz",
				id_token: "id-xyz",
				expires_at: Date.now() + 3_600_000,
				user: { sub: "u", email: "test@example.com", displayName: "Test" },
			}),
		);
		spyOn(proxy, "fetchApiKey").mockResolvedValue("sk-test-123");
		spyOn(configure, "configureClaudeCode").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.b",
			},
		]);

		const { stdin, frames } = render(<App />);
		await advanceFromSelectToInstalling(stdin);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
	});
});
