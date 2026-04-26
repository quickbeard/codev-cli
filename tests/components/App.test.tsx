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

async function pickSso(stdin: { write: (s: string) => void }) {
	// Wait for install to settle and the auth-method screen to appear, then
	// press Enter to pick the default "Login to SSO" option.
	await new Promise((r) => setTimeout(r, 100));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function pickManual(stdin: { write: (s: string) => void }) {
	// Wait for install to settle, move cursor to "I have my own API Key", Enter.
	await new Promise((r) => setTimeout(r, 100));
	stdin.write("[B"); // down arrow
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function typeManualCreds(
	stdin: { write: (s: string) => void },
	baseUrl: string,
	apiKey: string,
	model: string,
) {
	stdin.write(baseUrl);
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(apiKey);
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(model);
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
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
		await pickSso(stdin);
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
		await pickSso(stdin);
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
		const configureSpy = spyOn(
			configure,
			"configureClaudeCode",
		).mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.b",
			},
		]);

		const { stdin, frames } = render(<App />);
		await advanceFromSelectToInstalling(stdin);
		await pickSso(stdin);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(configureSpy).toHaveBeenCalledWith({ apiKey: "sk-test-123" });
	});

	test("manual-credentials flow reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		// bun's spyOn keeps call counts across tests in the same file, so re-
		// stub the SSO deps and then reset their counters before asserting.
		const loginSpy = spyOn(auth, "login").mockImplementation(
			() => new Promise(() => {}),
		);
		const fetchApiKeySpy = spyOn(proxy, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);
		const configureSpy = spyOn(
			configure,
			"configureClaudeCode",
		).mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.b",
			},
		]);
		loginSpy.mockClear();
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<App />);
		await advanceFromSelectToInstalling(stdin);
		await pickManual(stdin);
		await typeManualCreds(
			stdin,
			"https://my-gateway.example.com/v1",
			"sk-manual-123",
			"custom-model",
		);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Enter API credentials");
		expect(history).toContain("Happy coding");
		expect(loginSpy).not.toHaveBeenCalled();
		expect(fetchApiKeySpy).not.toHaveBeenCalled();
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-manual-123",
			baseUrl: "https://my-gateway.example.com/v1",
			model: "custom-model",
		});
	});

	test("SSO empty-key fallback into manual credentials reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		const loginSpy = spyOn(auth, "login").mockImplementation(() =>
			Promise.resolve({
				access_token: "access-xyz",
				id_token: "id-xyz",
				expires_at: Date.now() + 3_600_000,
				user: { sub: "u", email: "test@example.com", displayName: "Test" },
			}),
		);
		const fetchApiKeySpy = spyOn(proxy, "fetchApiKey").mockResolvedValue("");
		const configureSpy = spyOn(
			configure,
			"configureClaudeCode",
		).mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.b",
			},
		]);
		// bun's spyOn keeps call counts across tests in the same file.
		loginSpy.mockClear();
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<App />);
		await advanceFromSelectToInstalling(stdin);
		await pickSso(stdin);

		// Wait for SSO to "succeed" but with an empty api_key — Login should
		// render the fallback notice and prompt instead of advancing to Configure.
		await new Promise((r) => setTimeout(r, 150));
		expect(allFrames(frames)).toContain(
			"SSO succeeded but the gateway returned an empty API key.",
		);
		expect(allFrames(frames)).toContain(
			"Press Enter to enter credentials manually",
		);
		expect(configureSpy).not.toHaveBeenCalled();

		// Press Enter to acknowledge the fallback; the manual-credentials Step
		// should mount (without the user needing to revisit auth-method).
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 100));
		expect(allFrames(frames)).toContain("Enter API credentials");

		await typeManualCreds(
			stdin,
			"https://fallback.example.com/v1",
			"sk-fallback-123",
			"fallback-model",
		);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(loginSpy).toHaveBeenCalledTimes(1);
		expect(fetchApiKeySpy).toHaveBeenCalledTimes(1);
		expect(configureSpy).toHaveBeenCalledTimes(1);
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-fallback-123",
			baseUrl: "https://fallback.example.com/v1",
			model: "fallback-model",
		});
	});

	test("SSO retry after failure reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		const loginSpy = spyOn(auth, "login").mockImplementation(() =>
			Promise.resolve({
				access_token: "access-xyz",
				id_token: "id-xyz",
				expires_at: Date.now() + 3_600_000,
				user: { sub: "u", email: "test@example.com", displayName: "Test" },
			}),
		);
		const fetchApiKeySpy = spyOn(proxy, "fetchApiKey")
			.mockImplementationOnce(() =>
				Promise.reject(new Error("Proxy /auth/exchange failed (502): boom")),
			)
			.mockImplementationOnce(() => Promise.resolve("sk-retry-ok"));
		const configureSpy = spyOn(
			configure,
			"configureClaudeCode",
		).mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.b",
			},
		]);
		// bun's spyOn keeps call counts across tests in the same file.
		loginSpy.mockClear();
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<App />);
		await advanceFromSelectToInstalling(stdin);
		await pickSso(stdin);

		// Wait for the first attempt to reject and the retry prompt to render.
		await new Promise((r) => setTimeout(r, 150));
		expect(allFrames(frames)).toContain(
			"Login failed: Proxy /auth/exchange failed",
		);
		expect(allFrames(frames)).toContain("Press Enter to retry, Ctrl-C to quit");
		expect(configureSpy).not.toHaveBeenCalled();

		// Press Enter to retry; the second attempt resolves with sk-retry-ok.
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(loginSpy).toHaveBeenCalledTimes(2);
		expect(fetchApiKeySpy).toHaveBeenCalledTimes(2);
		expect(configureSpy).toHaveBeenCalledTimes(1);
		expect(configureSpy).toHaveBeenCalledWith({ apiKey: "sk-retry-ok" });
	});
});
