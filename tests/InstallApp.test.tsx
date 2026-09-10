import * as child_process from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InstallApp } from "@/InstallApp.js";
import * as auth from "@/lib/auth.js";
import * as backend from "@/lib/backend.js";
import * as codegraph from "@/lib/codegraph.js";
import * as configure from "@/lib/configure.js";
import { FALLBACK_MODEL } from "@/lib/const.js";
import * as npm from "@/lib/npm.js";
import * as ripgrep from "@/lib/ripgrep.js";
import * as shims from "@/lib/shims.js";
import {
	vscodeSettingsPath,
	vscodeUserDataDir,
} from "@/lib/vscode-settings.js";

function stubModels() {
	// ModelSelect also refreshes the cached per-model windows. Unmocked it would
	// issue a real request and, on a non-empty result, write to the developer's
	// real ~/.codev-hub/auth.json.
	vi.spyOn(backend, "fetchModelWindows").mockResolvedValue({});
	return vi
		.spyOn(backend, "fetchModels")
		.mockResolvedValue(["m-alpha", "m-beta"]);
}

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn() };
});

// jetbrains.ts's macOS fallback walks `/Applications` and `~/Applications`
// for `<IDE>.app` bundles when the shell launcher isn't on PATH. Without
// this mock, the JetBrains soft-fail test below would pick up the
// maintainer's real PyCharm.app and follow the install path instead of
// the warning path. Returning `[]` for any Applications directory forces
// the fallback into its "nothing found" branch; everything else passes
// through to real fs so the temp-home setup (mkdtempSync/rmSync) still
// works.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readdir = ((p: unknown, ...rest: unknown[]) => {
		if (typeof p === "string" && /(^|\/)Applications$/.test(p)) return [];
		return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
	}) as typeof actual.readdirSync;
	return { ...actual, readdirSync: readdir };
});

// InstallApp's manual-creds path calls saveApiKey(), which writes to
// ~/.codev-hub/auth.json. Without this redirect, every test run would clobber the
// developer's real auth.json with fixture keys like "sk-manual-123".
let installAppTempHome: string;

beforeEach(() => {
	installAppTempHome = mkdtempSync(join(tmpdir(), "codev-installapp-test-"));
	vi.stubEnv("HOME", installAppTempHome);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", installAppTempHome);
	// Keep the VS Code user-data dir resolution (vscode-settings.ts, invoked by
	// the finalize Phase on the configure path) inside the temp home on every
	// platform — otherwise a Linux/Windows runner could resolve to its real VS
	// Code config. Unseeded here, so disableClaudeCodeLoginPrompt() just skips.
	vi.stubEnv("APPDATA", join(installAppTempHome, "AppData", "Roaming"));
	vi.stubEnv("XDG_CONFIG_HOME", join(installAppTempHome, ".config"));
	// refreshCodevConfig hits the network. Mock it as a fast resolve so the
	// inline post-install refresh doesn't block tests on a real fetch.
	vi.spyOn(auth, "refreshCodevConfig").mockResolvedValue(undefined);
	// The Install step runs ensureCodegraphInstalled (npm i -g) and the finalize
	// Phase runs setupCodegraph (codegraph install). Default both to no-ops so
	// full-flow tests neither hang nor hit the network; specific tests override
	// them to assert the wiring.
	vi.spyOn(codegraph, "ensureCodegraphInstalled").mockResolvedValue(null);
	vi.spyOn(codegraph, "setupCodegraph").mockResolvedValue({
		status: "skipped",
		targets: [],
	});
	// The finalize Phase also stages ripgrep into CoDev Code's cache dir (a
	// real download from the landing page). Default to "present" so full-flow
	// tests neither hit the network nor write outside the temp home.
	vi.spyOn(ripgrep, "installRipgrep").mockResolvedValue({
		status: "present",
		path: null,
	});
	// The post-model gateway smoke test hits the gateway with a real completion;
	// default it to a pass so full-flow tests don't make a network call. The
	// failure-path test overrides it.
	vi.spyOn(backend, "smokeTestModel").mockResolvedValue(null);
	// codev-code is always installed and configured now, so the real
	// configureCodevCode runs in every flow. On the new-key path it would fall
	// back to AI_GATEWAY_OPENAI_URL() and hard-fail on the unpopulated
	// gateway_url cache, so stub it. Its own output is covered by
	// tests/providers/codev-code.test.ts and tests/lib/configure.test.ts.
	vi.spyOn(configure, "configureCodevCode").mockReturnValue([
		{
			kind: "codev-code-config",
			sourcePath: "/tmp/codev-code.json",
			backupPath: "/tmp/codev-code.json.backup",
			created: true,
		},
	]);
	// The finalize Phase calls installShims(), and on Windows that shells out to
	// a real `powershell -Command` (execFileSync — NOT the mocked execFile) to
	// rewrite the user-scope PATH in the registry. That's a synchronous spawn
	// which blocks the event loop for ~10s on its cold start, so the first flow
	// to reach finalize blows past waitForFrame's budget and never renders the
	// done screen — and it mutates the PATH of whatever machine runs the suite.
	// lib/shims.test.ts skips its installShims block on Windows for the same
	// reason; nothing here asserts shim files, so stub the whole call.
	vi.spyOn(shims, "installShims").mockReturnValue({
		shimDir: join(installAppTempHome, ".codev-hub", "bin"),
		shimsWritten: [],
		rcFilesUpdated: [],
		windowsUserPathUpdated: false,
	});
});

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

// Normalize execFile call shapes: production code uses (file, args, opts, cb)
// on POSIX and the single-string (cmdString, opts, cb) form on Windows (to
// avoid Node 22's DEP0190). The handler always gets (file, args).
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
	vi.mocked(child_process.execFile).mockImplementation(((
		...callArgs: unknown[]
	) => {
		const cb = callArgs[callArgs.length - 1] as ExecCb;
		const first = callArgs[0] as string;
		const second = callArgs[1];
		let file: string;
		let args: string[];
		if (Array.isArray(second)) {
			file = first;
			args = second as string[];
		} else {
			const tokens = first.split(/\s+/).filter(Boolean);
			file = tokens[0] ?? "";
			args = tokens.slice(1);
		}
		const r = handler(file, args);
		setImmediate(() => cb(r.error ?? null, r.stdout ?? "", r.stderr ?? ""));
		return {} as unknown as child_process.ChildProcess;
	}) as unknown as typeof child_process.execFile);
}

function fakeAuth(): auth.AuthData {
	return {
		access_token: "access-xyz",
		id_token: "id-xyz",
		expires_at: Date.now() + 3_600_000,
		user: { sub: "u", email: "test@example.com", displayName: "Test" },
	};
}

// Poll `frames` for a substring instead of sleeping for a fixed time. The Ink
// flow is async (login → install → refresh → validate → key-choice → …), and
// each transition involves React commit + useInput re-registration. Windows
// CI runs ~2–3× slower than the dev laptop, so any fixed-time sleep that
// works locally is a Heisenbug. Resolves silently when `maxMs` elapses —
// downstream assertions surface the real failure message.
//
// Includes a small settle after the match so the component's useInput handler
// has time to register on the render that contained `needle` — without this,
// an immediate stdin.write can land before the handler is active and get
// dropped.
async function waitForFrame(
	frames: string[],
	needle: string,
	maxMs = 3_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		if (frames.join("\n").includes(needle)) {
			await new Promise((r) => setTimeout(r, 30));
			return;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function advanceThroughConfirm(
	stdin: { write: (s: string) => void },
	frames: string[],
) {
	// Move cursor to Claude Code (second row, below CoDev Code), select,
	// confirm selection, accept backup-warning confirm (apt-style: type "y"
	// then Enter). Lands on LOGIN.
	await waitForFrame(frames, "Select the AI agent(s) to install");
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(" ");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await waitForFrame(frames, "Continue? [y/N]");
	stdin.write("y\r");
}

async function advanceThroughConfirmCodex(
	stdin: { write: (s: string) => void },
	frames: string[],
) {
	// Move cursor to the third option (Codex), select, confirm, accept warning.
	await waitForFrame(frames, "Select the AI agent(s) to install");
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(" ");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await waitForFrame(frames, "Continue? [y/N]");
	stdin.write("y\r");
}

// After install completes, refreshing-config + saved-key validation run
// (refreshCodevConfig is mocked in beforeEach) and the flow lands on the
// key-choice step. Wait for the choose-configuration screen (no-saved-key
// path) or the existing-key option (saved-key path) to actually appear.
async function settleAfterInstall(frames: string[]) {
	await waitForFrame(frames, "Choose configuration method");
}

async function pickNewKey(
	stdin: { write: (s: string) => void },
	frames: string[],
) {
	// Wait for login + install + refresh + validation to settle and the
	// key-choice screen to appear, then press Enter on the default first
	// option ("Get a new API Key" when no saved key exists).
	await settleAfterInstall(frames);
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function pickManual(
	stdin: { write: (s: string) => void },
	frames: string[],
) {
	// Wait for the upstream phases to settle, move cursor to "I have my
	// own API Key", Enter.
	await settleAfterInstall(frames);
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function pickSkip(
	stdin: { write: (s: string) => void },
	frames: string[],
) {
	// Wait for the upstream phases to settle, move cursor past
	// "Get a new API Key" and "I have my own API Key" to land on
	// "Skip configuration", Enter.
	await settleAfterInstall(frames);
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function typeManualCreds(
	stdin: { write: (s: string) => void },
	frames: string[],
	baseUrl: string,
	apiKey: string,
	// The provider-name field comes first and is optional — an empty string
	// just Enters past it, leaving the default identity to the caller.
	providerName = "",
) {
	await waitForFrame(frames, "Enter API credentials");
	if (providerName) {
		stdin.write(providerName);
		await new Promise((r) => setTimeout(r, 30));
	}
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(baseUrl);
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(apiKey);
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

// After credentials are known, the model-choice step runs ModelSelect. The
// component fires fetchModels on mount; this helper waits for the list and
// picks the first option (Enter on default cursor).
async function pickFirstModel(
	stdin: { write: (s: string) => void },
	frames: string[],
	expectedModel = "m-alpha",
) {
	await waitForFrame(frames, expectedModel);
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
	vi.restoreAllMocks();
	rmSync(installAppTempHome, { recursive: true, force: true });
});

// Default to "no saved API key" for tests that exercise the new/manual paths —
// otherwise InstallApp would discover whatever is in the dev's real
// ~/.codev-hub/auth.json and route through the validating-existing branch.
function stubNoSavedKey() {
	vi.spyOn(auth, "loadApiKey").mockReturnValue(null);
}

describe("InstallApp fail-stop invariant", () => {
	beforeEach(() => {
		stubNoSavedKey();
	});

	test("login failure halts the flow before install runs", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockImplementation(() =>
			Promise.reject(new Error("Connection refused")),
		);

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await waitForFrame(frames, "Login failed: Connection refused");

		const history = allFrames(frames);
		expect(history).toContain("Login failed: Connection refused");
		expect(history).not.toContain("Installing packages");
		expect(history).not.toContain("Configure tools");
	});

	test("install failure does not advance to key-choice", async () => {
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "i") {
				const err = Object.assign(new Error("spawn npm ENOENT"), {
					code: "ENOENT",
				});
				return { error: err, stderr: "spawn npm ENOENT" };
			}
			return { stdout: "1.0.0" };
		});

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await waitForFrame(frames, "Failed to install");

		const history = allFrames(frames);
		expect(history).toContain("Failed to install");
		// Once login completes, the Login step collapses to a green signed-in line.
		expect(history).toContain("✓ Signed in as test@example.com");
		expect(history).not.toContain("Get a new API Key");
		expect(history).not.toContain("Configure tools");
	});

	test("fetch-key failure halts the flow before configure", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockImplementation(() =>
			Promise.reject(new Error("Backend /auth/exchange failed (502): boom")),
		);
		const configureSpy = vi.spyOn(configure, "configureClaudeCode");

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickNewKey(stdin, frames);
		await waitForFrame(frames, "Failed to fetch API key");

		const history = allFrames(frames);
		expect(history).toContain("Failed to fetch API key");
		expect(history).toContain("Press Enter to retry, Ctrl-C to quit");
		expect(history).not.toContain("Configure tools");
		expect(configureSpy).not.toHaveBeenCalled();
	});

	test("configure failure does not reach the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-test-123");
		vi.spyOn(configure, "configureClaudeCode").mockImplementation(() => {
			throw new Error("disk full");
		});

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Configure failed: disk full");

		const history = allFrames(frames);
		expect(history).toContain("Configure tools");
		expect(history).toContain("Configure failed: disk full");
		expect(history).not.toContain("Happy coding");
	});

	test("successful flow reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-test-123");
		const configureSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: true,
				},
			]);

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-test-123",
			model: "m-alpha",
			models: ["m-alpha", "m-beta"],
		});
		// codev-code is always configured alongside the selected agent(s).
		expect(configure.configureCodevCode).toHaveBeenCalledWith({
			apiKey: "sk-test-123",
			model: "m-alpha",
			models: ["m-alpha", "m-beta"],
		});
	});

	test("wires CodeGraph for the selected agent after a successful install", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-test-123");
		vi.spyOn(configure, "configureClaudeCode").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.b",
				created: true,
			},
		]);
		vi.mocked(codegraph.setupCodegraph).mockResolvedValue({
			status: "ok",
			targets: ["claude"],
		});

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		// CodeGraph is installed during the Installing step (alongside
		// the agents), then the finalize step wires the MCP server. Survivors are
		// handed to setupCodegraph verbatim; the mapping/dedupe to `--target` is
		// covered in lib/codegraph.test.ts.
		expect(codegraph.ensureCodegraphInstalled).toHaveBeenCalled();
		// The always-on codev-code leads the survivor set; claude-code is the
		// tool that actually maps to a CodeGraph target (see lib/codegraph.test.ts).
		expect(codegraph.setupCodegraph).toHaveBeenCalledWith([
			"codev-code",
			"claude-code",
		]);
		expect(allFrames(frames)).toContain("Wired CodeGraph into Claude Code");
	});

	test("a CodeGraph setup failure warns but does not block completion", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-test-123");
		vi.spyOn(configure, "configureClaudeCode").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.b",
				created: true,
			},
		]);
		vi.mocked(codegraph.setupCodegraph).mockResolvedValue({
			status: "warning",
			targets: ["claude"],
			message: "CodeGraph install failed: boom",
		});

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("CodeGraph install failed: boom");
		// Best-effort: the warning never aborts the CoDev flow.
		expect(history).toContain("Happy coding");
	});

	test("Codex selection routes to configureCodex and reaches done", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-codex-123");
		const configureCodexSpy = vi
			.spyOn(configure, "configureCodex")
			.mockReturnValue([
				{
					kind: "codex-config",
					sourcePath: "/tmp/codex.toml",
					backupPath: "/tmp/codex.toml.backup",
					created: true,
				},
			]);
		configureCodexSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirmCodex(stdin, frames);
		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(configureCodexSpy).toHaveBeenCalledTimes(1);
		expect(configureCodexSpy).toHaveBeenCalledWith({
			apiKey: "sk-codex-123",
			model: "m-alpha",
			models: ["m-alpha", "m-beta"],
		});
	});

	test("manual-credentials flow reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		const loginSpy = vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const fetchApiKeySpy = vi
			.spyOn(backend, "fetchApiKey")
			.mockImplementation(() => new Promise(() => {}));
		const configureSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: true,
				},
			]);
		loginSpy.mockClear();
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickManual(stdin, frames);
		await typeManualCreds(
			stdin,
			frames,
			"https://my-gateway.example.com/v1",
			"sk-manual-123",
			"Acme AI",
		);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Enter API credentials");
		expect(history).toContain("Happy coding");
		expect(loginSpy).toHaveBeenCalledTimes(1);
		expect(fetchApiKeySpy).not.toHaveBeenCalled();
		// The typed provider name reaches configure as the identity pair, and is
		// persisted so `codevhub model` and the launch-time key refresh reuse it.
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-manual-123",
			baseUrl: "https://my-gateway.example.com/v1",
			model: "m-alpha",
			models: ["m-alpha", "m-beta"],
			providerId: "acme-ai",
			providerName: "Acme AI",
		});
		// loadApiKey is stubbed for these tests, so assert the file saveApiKey
		// actually wrote into the temp home.
		expect(
			JSON.parse(
				readFileSync(
					join(installAppTempHome, ".codev-hub", "auth.json"),
					"utf-8",
				),
			),
		).toMatchObject({
			api_key: "sk-manual-123",
			provider_id: "acme-ai",
			provider_name: "Acme AI",
		});
	});

	test("empty-key retry then second empty falls back into manual creds", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const fetchApiKeySpy = vi
			.spyOn(backend, "fetchApiKey")
			.mockResolvedValue("");
		const configureSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: true,
				},
			]);
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickNewKey(stdin, frames);

		// First empty result — retry prompt should render, no fallback yet.
		await waitForFrame(frames, "Gateway returned an empty API key.");
		expect(allFrames(frames)).toContain("Gateway returned an empty API key.");
		expect(allFrames(frames)).toContain("Press Enter to retry");
		expect(allFrames(frames)).not.toContain(
			"Press Enter to enter credentials manually",
		);

		// Press Enter to retry; second attempt also returns empty.
		stdin.write("\r");
		await waitForFrame(frames, "Gateway returned an empty API key again.");
		expect(allFrames(frames)).toContain(
			"Gateway returned an empty API key again.",
		);
		expect(allFrames(frames)).toContain(
			"Press Enter to enter credentials manually",
		);
		expect(configureSpy).not.toHaveBeenCalled();

		// Press Enter to drop into manual creds.
		stdin.write("\r");
		await waitForFrame(frames, "Enter API credentials");
		expect(allFrames(frames)).toContain("Enter API credentials");

		await typeManualCreds(
			stdin,
			frames,
			"https://fallback.example.com/v1",
			"sk-fallback-123",
		);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(fetchApiKeySpy).toHaveBeenCalledTimes(2);
		expect(configureSpy).toHaveBeenCalledTimes(1);
		// No provider name typed on this fallback path, so the manual default
		// identity applies.
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-fallback-123",
			baseUrl: "https://fallback.example.com/v1",
			model: "m-alpha",
			models: ["m-alpha", "m-beta"],
			providerId: "ai-gateway",
			providerName: "AI Gateway",
		});
	});

	test("fetch-key retry after failure reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const fetchApiKeySpy = vi
			.spyOn(backend, "fetchApiKey")
			.mockImplementationOnce(() =>
				Promise.reject(new Error("Backend /auth/exchange failed (502): boom")),
			)
			.mockImplementationOnce(() => Promise.resolve("sk-retry-ok"));
		const configureSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: true,
				},
			]);
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickNewKey(stdin, frames);

		// First attempt rejects — retry prompt renders.
		await waitForFrame(
			frames,
			"Failed to fetch API key: Backend /auth/exchange failed",
		);
		expect(allFrames(frames)).toContain(
			"Failed to fetch API key: Backend /auth/exchange failed",
		);
		expect(allFrames(frames)).toContain("Press Enter to retry, Ctrl-C to quit");
		expect(configureSpy).not.toHaveBeenCalled();

		// Press Enter to retry; second attempt resolves and the model-choice
		// step renders.
		stdin.write("\r");
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(fetchApiKeySpy).toHaveBeenCalledTimes(2);
		expect(configureSpy).toHaveBeenCalledTimes(1);
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-retry-ok",
			model: "m-alpha",
			models: ["m-alpha", "m-beta"],
		});
	});

	test("skip-configuration flow backs up silently and writes no configs", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const fetchApiKeySpy = vi
			.spyOn(backend, "fetchApiKey")
			.mockImplementation(() => new Promise(() => {}));
		const configureSpy = vi.spyOn(configure, "configureClaudeCode");
		const backupOnlySpy = vi.spyOn(configure, "backupOnly").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.backup",
				created: true,
			},
		]);
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();
		backupOnlySpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickSkip(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Skip configuration");
		expect(history).toContain("Happy coding");
		// The backup still runs for its side-effect — once for the always-on
		// codev-code and once for the selected claude-code.
		expect(backupOnlySpy).toHaveBeenCalledTimes(2);
		expect(backupOnlySpy).toHaveBeenCalledWith("codev-code");
		expect(backupOnlySpy).toHaveBeenCalledWith("claude-code");
		expect(configureSpy).not.toHaveBeenCalled();
		expect(fetchApiKeySpy).not.toHaveBeenCalled();
		// …but the Skip path renders no backup Step. The configure-path title
		// and rows (emitted on the non-skip branch of the same render) must not
		// appear here.
		expect(history).not.toContain("Configure tools");
		expect(history).not.toContain("Configured Claude Code");
	});

	test("login retry after failure reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		const loginSpy = vi
			.spyOn(auth, "login")
			.mockImplementationOnce(() => Promise.reject(new Error("network down")))
			.mockImplementationOnce(() => Promise.resolve(fakeAuth()));
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-test-123");
		const configureSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: true,
				},
			]);
		loginSpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);

		// Wait for the first login attempt to reject.
		await waitForFrame(frames, "Login failed: network down");
		expect(allFrames(frames)).toContain("Login failed: network down");
		expect(allFrames(frames)).toContain("Press Enter to retry, Ctrl-C to quit");
		expect(configureSpy).not.toHaveBeenCalled();

		// Press Enter to retry login.
		stdin.write("\r");
		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(loginSpy).toHaveBeenCalledTimes(2);
		expect(configureSpy).toHaveBeenCalledTimes(1);
	});

	test("Continue selection expands via editor sub-select; soft-fail install still reaches Configure", async () => {
		// Pick Continue → editor sub-select (VS Code) → soft-fail `code` not
		// on PATH → flow advances to Configure, which renders the warning
		// hint instead of aborting. The whole point of option B: a transient
		// CLI install failure must not block the YAML config write.
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-cont-123");
		const configureSpy = vi
			.spyOn(configure, "configureContinue")
			.mockReturnValue([
				{
					kind: "continue-config",
					sourcePath: "/tmp/c.yaml",
					backupPath: "/tmp/c.yaml.backup",
					created: true,
				},
			]);
		configureSpy.mockClear();
		// `code --install-extension …` returns ENOENT → installContinueExtension
		// resolves `{ warning: "VS Code launcher not found on PATH" }`. No npm runs
		// because Continue isn't an NpmTool.
		stubExecFile((file) => {
			if (file === "code") {
				const err = Object.assign(new Error("spawn code ENOENT"), {
					code: "ENOENT",
				});
				return { error: err, stderr: "" };
			}
			return { stdout: "ok" };
		});

		const { stdin, frames } = render(<InstallApp />);

		// Pick the Continue (extension) row (6th, index 5).
		await waitForFrame(frames, "Select the AI agent(s) to install");
		for (let i = 0; i < 5; i++) {
			stdin.write("\x1B[B");
			await new Promise((r) => setTimeout(r, 30));
		}
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");

		// Editor sub-select appears — pick VS Code (row 0).
		await waitForFrame(frames, "Select the editor(s) to install extensions");
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");

		// Confirm screen → backup-warning prompt.
		await waitForFrame(frames, "Continue? [y/N]");
		stdin.write("y\r");

		// Standard login + fetch-key + model-choice path.
		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		// Frame-border `│` chars split long wrapped lines; strip them and
		// collapse whitespace so substring matches survive the wrap.
		const history = allFrames(frames).replace(/│/g, " ").replace(/\s+/g, " ");
		expect(history).toContain("Happy coding");
		// Configure was called for Continue (single dedup'd write).
		expect(configureSpy).toHaveBeenCalledTimes(1);
		// The install row surfaces the cause + manual-install reassurance.
		expect(history).toContain("VS Code launcher not found on PATH");
		expect(history).toContain(
			"You can install the Continue extension yourself later.",
		);
	});

	test("non-ENOENT Continue install failure (proxy / marketplace 5xx) still reaches Configure", async () => {
		// Companion to the ENOENT test above: this one stubs the `code` CLI
		// as PRESENT but failing — e.g. a proxy/marketplace error. With
		// option B, this is still a soft fail: the install row paints
		// yellow ▲ with the stderr as the warning, the Configure pane
		// surfaces it in the resume hint, and the flow reaches Happy coding
		// rather than parking at install-failed. The original behavior on
		// this branch was to hard-abort here, which would have stranded the
		// user any time the marketplace had a hiccup.
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-cont-456");
		const configureSpy = vi
			.spyOn(configure, "configureContinue")
			.mockReturnValue([
				{
					kind: "continue-config",
					sourcePath: "/tmp/c.yaml",
					backupPath: "/tmp/c.yaml.backup",
					created: true,
				},
			]);
		configureSpy.mockClear();
		// `code` runs but returns non-zero — no ENOENT, just a stderr
		// payload (the kind of failure that used to abort the flow).
		stubExecFile((file) => {
			if (file === "code") {
				return {
					error: new Error("exit 1"),
					stderr: "Proxy returned 502 Bad Gateway",
				};
			}
			return { stdout: "ok" };
		});

		const { stdin, frames } = render(<InstallApp />);

		// Pick the Continue (extension) row (6th, index 5) and the VS Code editor.
		await waitForFrame(frames, "Select the AI agent(s) to install");
		for (let i = 0; i < 5; i++) {
			stdin.write("\x1B[B");
			await new Promise((r) => setTimeout(r, 30));
		}
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");

		await waitForFrame(frames, "Select the editor(s) to install extensions");
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");

		await waitForFrame(frames, "Continue? [y/N]");
		stdin.write("y\r");

		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		// Ink wraps long lines inside the rendered frame AND prefixes each
		// wrapped line with the Frame component's `│` border character — so
		// the manual-install reassurance can end up split as "You can install
		// the │ Continue extension yourself later." in the joined history.
		// Strip the border pipes and collapse whitespace before matching.
		const history = allFrames(frames).replace(/│/g, " ").replace(/\s+/g, " ");
		// 1. The YAML config was still written — soft fail must not block
		//    the part of the flow CoDev actually owns.
		expect(configureSpy).toHaveBeenCalledTimes(1);
		// 2. The flow completed — no install-failed parking lot.
		expect(history).toContain("Happy coding");
		expect(history).not.toContain("Failed to install");
		// 3. The install row surfaced the real cause (proxy/marketplace
		//    error) + the manual-install reassurance.
		expect(history).toContain("Proxy returned 502 Bad Gateway");
		expect(history).toContain(
			"You can install the Continue extension yourself later.",
		);
	});

	test("JetBrains-only Continue install: no launcher on PATH still reaches Configure", async () => {
		// Mirror of the VS Code soft-fail tests, but exercising the
		// `jetbrains-continue` install branch — every JetBrains shell
		// launcher we probe (idea/pycharm/goland) returns ENOENT. The flow
		// must still reach Happy coding, the install row carries
		// JETBRAINS_HINT, and the Configure pane's plugin-specific yellow
		// hint surfaces. Pins both the install-row hint string (was not
		// covered at integration level before) and the JetBrains-side
		// Configure-pane hint.
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-jb-123");
		const configureSpy = vi
			.spyOn(configure, "configureContinue")
			.mockReturnValue([
				{
					kind: "continue-config",
					sourcePath: "/tmp/c.yaml",
					backupPath: "/tmp/c.yaml.backup",
					created: true,
				},
			]);
		configureSpy.mockClear();
		stubExecFile((file) => {
			if (file === "idea" || file === "pycharm" || file === "goland") {
				const err = Object.assign(new Error(`spawn ${file} ENOENT`), {
					code: "ENOENT",
				});
				return { error: err, stderr: "" };
			}
			return { stdout: "ok" };
		});

		const { stdin, frames } = render(<InstallApp />);

		// Continue (extension) row (6th, index 5) → editor sub-select → JetBrains.
		await waitForFrame(frames, "Select the AI agent(s) to install");
		for (let i = 0; i < 5; i++) {
			stdin.write("\x1B[B");
			await new Promise((r) => setTimeout(r, 30));
		}
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");

		await waitForFrame(frames, "Select the editor(s) to install extensions");
		// Move cursor down to JetBrains (second row), select, confirm.
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");

		await waitForFrame(frames, "Continue? [y/N]");
		stdin.write("y\r");

		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames).replace(/│/g, " ").replace(/\s+/g, " ");
		// YAML still written, flow not aborted.
		expect(configureSpy).toHaveBeenCalledTimes(1);
		expect(history).toContain("Happy coding");
		expect(history).not.toContain("Failed to install");
		// Install row surfaces the JetBrains-launcher cause text + the
		// manual-install reassurance.
		expect(history).toContain(
			"JetBrains launcher not found on PATH (PyCharm / IntelliJ IDEA / GoLand)",
		);
		expect(history).toContain(
			"You can install the Continue plugin yourself later.",
		);
	});

	test("Claude Code (extension) selection routes to configureClaudeCode (shared backup kind)", async () => {
		// Picks Claude Code (extension) in ToolSelect → merged editor sub-
		// select → VS Code → standard auth + model flow. The configurator
		// called is `configureClaudeCode` (not a separate extension config
		// path) because the CLI and extension share `~/.claude/settings.json`.
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-ccext-123");
		const configureSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/claude.json",
					backupPath: "/tmp/claude.json.backup",
					created: true,
				},
			]);
		configureSpy.mockClear();
		// `code --install-extension` resolves fine; the npm path never runs
		// because the extension tool is not an NpmTool.
		stubExecFile(() => ({ stdout: "ok" }));

		const { stdin, frames } = render(<InstallApp />);

		// Pick the Claude Code (extension) row (5th, index 4).
		await waitForFrame(frames, "Select the AI agent(s) to install");
		for (let i = 0; i < 4; i++) {
			stdin.write("\x1B[B");
			await new Promise((r) => setTimeout(r, 30));
		}
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");

		// Merged editor sub-select — pick VS Code (row 0).
		await waitForFrame(frames, "Select the editor(s) to install extensions");
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");

		await waitForFrame(frames, "Continue? [y/N]");
		stdin.write("y\r");

		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		expect(configureSpy).toHaveBeenCalledTimes(1);
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-ccext-123",
			model: "m-alpha",
			models: ["m-alpha", "m-beta"],
		});
	});

	test("Claude Code CLI + extension share the backup kind: single configure call, both install tasks scheduled", async () => {
		// Picks Claude Code CLI (2nd row) AND Claude Code (extension) (5th
		// row), then VS Code in the merged sub-select. Asserts:
		//  - `configureClaudeCode` runs exactly once (shared BackupKind).
		//  - Both the npm install task (@anthropic-ai/claude-code) and the
		//    extension install task (anthropic.claude-code (VS Code)) appear.
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-both-123");
		const configureSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/claude.json",
					backupPath: "/tmp/claude.json.backup",
					created: true,
				},
			]);
		configureSpy.mockClear();
		// npm install + npm root + claude --version + `code` all succeed.
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") {
				return { stdout: "/fake/root" };
			}
			return { stdout: "ok" };
		});

		const { stdin, frames } = render(<InstallApp />);

		await waitForFrame(frames, "Select the AI agent(s) to install");
		// Row 1 (Claude Code CLI) — toggle, then arrow down to row 4 and toggle.
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		for (let i = 0; i < 3; i++) {
			stdin.write("\x1B[B");
			await new Promise((r) => setTimeout(r, 30));
		}
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");

		await waitForFrame(frames, "Select the editor(s) to install extensions");
		stdin.write(" "); // VS Code
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");

		await waitForFrame(frames, "Continue? [y/N]");
		stdin.write("y\r");

		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames).replace(/│/g, " ").replace(/\s+/g, " ");
		// Both install task rows showed up.
		expect(history).toContain("@anthropic-ai/claude-code");
		expect(history).toContain("anthropic.claude-code (VS Code)");
		// And configureClaudeCode ran exactly once thanks to the per-kind dedup.
		expect(configureSpy).toHaveBeenCalledTimes(1);
	});

	test("models fetch failure falls back to the default model and proceeds", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-test-123");
		const fetchModelsSpy = vi
			.spyOn(backend, "fetchModels")
			.mockRejectedValue(new Error("Models fetch failed (502): boom"));
		const configureSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: true,
				},
			]);
		configureSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickNewKey(stdin, frames);

		// A 502 (non-auth) failure warns and proceeds with the baked-in fallback
		// instead of blocking on the retry prompt.
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Couldn't fetch the model list");
		expect(history).toContain(FALLBACK_MODEL);
		expect(history).not.toContain("Press Enter to retry");
		// A single attempt — the fallback path doesn't retry.
		expect(fetchModelsSpy).toHaveBeenCalledTimes(1);
		expect(configureSpy).toHaveBeenCalledTimes(1);
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-test-123",
			model: FALLBACK_MODEL,
			models: [FALLBACK_MODEL],
		});
	});

	test("partial install failure: survivor advances to Configure, failed tool is dropped", async () => {
		// User selects both Claude Code and Codex. The codex npm install
		// hard-fails ("disk full"); the claude-code one succeeds. Pre-change
		// behavior was to park at install-failed and force the user to Ctrl-C.
		// New behavior: the survivor (claude-code) carries the flow into
		// Configure, configureCodex is never called, and the codex ✗ row
		// stays rendered above as the visual cue that one tool dropped out.
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-test-123");
		vi.spyOn(npm, "installAndVerify").mockImplementation(async (tool) =>
			tool === "codex" ? "disk full" : null,
		);
		const configureClaudeCodeSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: true,
				},
			]);
		const configureCodexSpy = vi.spyOn(configure, "configureCodex");

		const { stdin, frames } = render(<InstallApp />);

		// Select Claude Code (row 1), down arrow, select Codex (row 2), Enter.
		await waitForFrame(frames, "Select the AI agent(s) to install");
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");
		await waitForFrame(frames, "Continue? [y/N]");
		stdin.write("y\r");

		await pickNewKey(stdin, frames);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		// 1. The flow reached the done screen — not parked at install-failed.
		expect(history).toContain("Happy coding");
		// 2. The failed row is visible AND the survivor's row is visible.
		expect(history).toContain("Failed to install");
		expect(history).toContain("disk full");
		// 3. Configure only ran for the survivor — codex was dropped from the
		//    second half of the flow.
		expect(configureClaudeCodeSpy).toHaveBeenCalledTimes(1);
		expect(configureCodexSpy).not.toHaveBeenCalled();
	});
});

describe("InstallApp existing-key path", () => {
	test("validating an existing key shows it, surfaces the option, and reuses saved creds", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		const loadSpy = vi.spyOn(auth, "loadApiKey").mockReturnValue({
			apiKey: "sk-existing-123",
			baseUrl: "https://my-gateway.example.com/v1",
			// Saved model matches one in the stubbed /v1/models list so the
			// "saved model pre-marked as selected" regression can actually fire.
			model: "m-alpha",
		});
		const validateSpy = vi
			.spyOn(backend, "validateApiKey")
			.mockResolvedValue(true);
		const loginSpy = vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const fetchApiKeySpy = vi
			.spyOn(backend, "fetchApiKey")
			.mockImplementation(() => new Promise(() => {}));
		const configureSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: true,
				},
			]);
		loadSpy.mockClear();
		validateSpy.mockClear();
		loginSpy.mockClear();
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		// Wait for refresh + validation to settle and the saved-key option to
		// appear in the key-choice list.
		await waitForFrame(frames, "Reuse existing API Key");

		const beforeChoice = allFrames(frames);
		expect(beforeChoice).toContain("Reuse existing API Key");
		expect(beforeChoice).toContain("Get a new API Key");

		// Default cursor is on the existing option — Enter selects it directly.
		stdin.write("\r");
		// Existing path still routes through model-choice; the user can re-pick.
		// Wait for the models list to render and capture the frame BEFORE picking.
		// Even though the saved model ("m-alpha") matches a row in the list, no
		// model row should be pre-marked with the green ● — that glyph only
		// shows AFTER the user has actually picked something on this run.
		await waitForFrame(frames, "m-alpha");
		const beforePick = frames[frames.length - 1] ?? "";
		expect(beforePick).toContain("m-alpha");
		expect(beforePick).not.toContain("● m-alpha");
		expect(beforePick).not.toContain("● m-beta");

		stdin.write("\r");
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(loginSpy).toHaveBeenCalledTimes(1);
		expect(fetchApiKeySpy).not.toHaveBeenCalled();
		expect(validateSpy).toHaveBeenCalledTimes(1);
		expect(validateSpy).toHaveBeenCalledWith(
			"sk-existing-123",
			"https://my-gateway.example.com/v1",
		);
		// Model from the model-choice step overrides the saved model — confirms
		// existing users can change their model on reinstall.
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-existing-123",
			baseUrl: "https://my-gateway.example.com/v1",
			model: "m-alpha",
			models: ["m-alpha", "m-beta"],
		});
	});

	test("invalid saved key surfaces an error and does not show the existing option", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "loadApiKey").mockReturnValue({ apiKey: "sk-stale" });
		vi.spyOn(backend, "validateApiKey").mockResolvedValue(false);
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await waitForFrame(frames, "Saved API key is no longer valid");

		const history = allFrames(frames);
		expect(history).toContain("Saved API key is no longer valid");
		expect(history).not.toContain("Reuse existing API Key");
		expect(history).toContain("Get a new API Key");
	});

	test("validation network error is reported and option is hidden", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "loadApiKey").mockReturnValue({ apiKey: "sk-x" });
		vi.spyOn(backend, "validateApiKey").mockRejectedValue(
			new Error("fetch failed: ECONNREFUSED"),
		);
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await waitForFrame(frames, "Could not verify saved API key");

		const history = allFrames(frames);
		expect(history).toContain("Could not verify saved API key");
		expect(history).toContain("ECONNREFUSED");
		expect(history).not.toContain("Reuse existing API Key");
	});
});

// Regression: the finalize Phase picks backupClaudeAuth vs resetClaudeAuth off
// `creds === null`. Skip-configuration sets creds=null, so the originals must
// survive; any non-Skip path lands with creds≠null and the destructive reset
// fires. These tests touch the real (stubbed-HOME) ~/.claude.json and
// ~/.claude/.credentials.json — no spies on configure — to catch wiring
// regressions that mocked tests would miss.
describe("InstallApp finalize: Claude file fate by auth choice", () => {
	function seedClaudeFiles(): {
		jsonPath: string;
		credPath: string;
		jsonOriginal: { marker: string };
		credOriginal: { session: string };
	} {
		const jsonPath = join(installAppTempHome, ".claude.json");
		const credDir = join(installAppTempHome, ".claude");
		const credPath = join(credDir, ".credentials.json");
		const jsonOriginal = { marker: "user-pre-codev-state" };
		const credOriginal = { session: "user-prior-session" };
		mkdirSync(credDir, { recursive: true });
		writeFileSync(jsonPath, JSON.stringify(jsonOriginal));
		writeFileSync(credPath, JSON.stringify(credOriginal));
		return { jsonPath, credPath, jsonOriginal, credOriginal };
	}

	test("Skip configuration preserves ~/.claude.json and ~/.claude/.credentials.json originals", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);

		const { jsonPath, credPath, jsonOriginal, credOriginal } =
			seedClaudeFiles();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickSkip(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		// Source files untouched — neither replaced with the
		// hasCompletedOnboarding stub nor deleted.
		expect(JSON.parse(readFileSync(jsonPath, "utf-8"))).toEqual(jsonOriginal);
		expect(existsSync(credPath)).toBe(true);
		expect(JSON.parse(readFileSync(credPath, "utf-8"))).toEqual(credOriginal);
		// Backups still created (the finalize Phase runs backupClaudeAuth on
		// Skip), so the user can `codevhub restore claude` later.
		expect(JSON.parse(readFileSync(`${jsonPath}.backup`, "utf-8"))).toEqual(
			jsonOriginal,
		);
		expect(JSON.parse(readFileSync(`${credPath}.backup`, "utf-8"))).toEqual(
			credOriginal,
		);
	});

	test("manual-credentials path triggers the destructive reset (replaces .claude.json, removes .credentials.json)", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);
		vi.spyOn(backend, "validateApiKey").mockResolvedValue(true);
		// Stub the actual settings.json writer to prevent the real configure
		// from racing the assertions below; we only care about the .claude.json
		// + .credentials.json transitions here, which are owned by finalize.
		vi.spyOn(configure, "configureClaudeCode").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.backup",
				created: true,
			},
		]);

		const { jsonPath, credPath, jsonOriginal, credOriginal } =
			seedClaudeFiles();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickManual(stdin, frames);
		await typeManualCreds(
			stdin,
			frames,
			"https://gateway.example.com/v1",
			"sk-manual-claude-123",
		);
		await pickFirstModel(stdin, frames, "m-alpha");
		await waitForFrame(frames, "Happy coding");

		// Backups carry the original contents.
		expect(JSON.parse(readFileSync(`${jsonPath}.backup`, "utf-8"))).toEqual(
			jsonOriginal,
		);
		expect(JSON.parse(readFileSync(`${credPath}.backup`, "utf-8"))).toEqual(
			credOriginal,
		);
		// Live ~/.claude.json was overwritten with the bypass stub.
		expect(JSON.parse(readFileSync(jsonPath, "utf-8"))).toEqual({
			hasCompletedOnboarding: true,
		});
		// Live ~/.claude/.credentials.json was removed.
		expect(existsSync(credPath)).toBe(false);
	});
});

// The finalize Phase also disables the Claude Code VS Code extension's login
// prompt — but only on the configure path (creds≠null) and only when VS Code
// is installed. These touch the real (stubbed-HOME) settings.json to catch
// wiring regressions a mocked test would miss. APPDATA / XDG_CONFIG_HOME are
// stubbed under the temp home in beforeEach, so the seeded dir is the only one
// in play on every platform.
describe("InstallApp finalize: VS Code login prompt", () => {
	// Create the user-data dir (and User/) so the install-gate passes and we can
	// write settings.json into it.
	function seedVscodeInstalled() {
		mkdirSync(join(vscodeUserDataDir(), "User"), { recursive: true });
	}

	test("configure path adds claudeCode.disableLoginPrompt, preserving other settings", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);
		// Stub the ~/.claude/settings.json writer so the real configure doesn't
		// race the assertions; finalize (which owns the VS Code edit) still runs.
		vi.spyOn(configure, "configureClaudeCode").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.backup",
				created: true,
			},
		]);

		seedVscodeInstalled();
		const settingsPath = vscodeSettingsPath();
		writeFileSync(settingsPath, '{\n  "editor.fontSize": 14\n}\n');

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickManual(stdin, frames);
		await typeManualCreds(
			stdin,
			frames,
			"https://gateway.example.com/v1",
			"sk-vscode-123",
		);
		await pickFirstModel(stdin, frames, "m-alpha");
		await waitForFrame(frames, "Happy coding");

		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(settings["claudeCode.disableLoginPrompt"]).toBe(true);
		// The user's pre-existing setting survived the surgical edit.
		expect(settings["editor.fontSize"]).toBe(14);
	});

	test("Skip configuration leaves VS Code settings untouched", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);

		seedVscodeInstalled();
		const settingsPath = vscodeSettingsPath();
		const original = '{\n  "editor.fontSize": 14\n}\n';
		writeFileSync(settingsPath, original);

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickSkip(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		// Skip runs backupClaudeAuth, not the VS Code edit — file is unchanged.
		expect(readFileSync(settingsPath, "utf-8")).toBe(original);
	});
});
