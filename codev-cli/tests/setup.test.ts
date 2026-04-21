import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let homedirSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-test-"));
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir);
});

afterEach(() => {
	homedirSpy.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("bypassClaudeLogin", () => {
	test("creates .claude.json with hasCompletedOnboarding when file does not exist", async () => {
		const { bypassClaudeLogin } = await import("@/setup.js");
		bypassClaudeLogin();

		const filePath = join(tempDir, ".claude.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
	});

	test("adds hasCompletedOnboarding to existing file without it", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, JSON.stringify({ someKey: "someValue" }, null, 2));

		const { bypassClaudeLogin } = await import("@/setup.js");
		bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
		expect(config.someKey).toBe("someValue");
	});

	test("does not overwrite file when hasCompletedOnboarding already set", async () => {
		const filePath = join(tempDir, ".claude.json");
		const original = { hasCompletedOnboarding: true, other: "data" };
		writeFileSync(filePath, JSON.stringify(original, null, 2));

		const { bypassClaudeLogin } = await import("@/setup.js");
		bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config).toEqual(original);
	});

	test("handles invalid JSON in existing file", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, "not valid json{{{");

		const { bypassClaudeLogin } = await import("@/setup.js");
		bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
	});

	test("does not create a .claude.json.backup", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, JSON.stringify({ someKey: "someValue" }));

		const { bypassClaudeLogin } = await import("@/setup.js");
		bypassClaudeLogin();

		expect(existsSync(`${filePath}.backup`)).toBe(false);
	});
});

describe("configureClaudeCode", () => {
	test("creates ~/.claude/settings.json with env block when file does not exist", async () => {
		const { configureClaudeCode } = await import("@/setup.js");
		configureClaudeCode("sk-abc");

		const filePath = join(tempDir, ".claude", "settings.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.$schema).toBe(
			"https://json.schemastore.org/claude-code-settings.json",
		);
		expect(config.env).toEqual({
			ANTHROPIC_BASE_URL: "https://netmind.viettel.vn/gateway/",
			ANTHROPIC_API_KEY: "sk-abc",
			ANTHROPIC_MODEL: "MiniMax",
			ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax",
			CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
		});
	});

	test("also runs bypassClaudeLogin (creates .claude.json)", async () => {
		const { configureClaudeCode } = await import("@/setup.js");
		configureClaudeCode("sk-abc");

		const claudeJson = join(tempDir, ".claude.json");
		expect(existsSync(claudeJson)).toBe(true);
		const config = JSON.parse(readFileSync(claudeJson, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
	});

	test("replaces existing settings.json and backs up the directory", async () => {
		const dir = join(tempDir, ".claude");
		const backupDir = join(tempDir, ".claude.backup");
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "settings.json");
		writeFileSync(
			filePath,
			JSON.stringify({
				otherKey: "keep",
				env: { FOO: "bar", ANTHROPIC_API_KEY: "old" },
			}),
		);
		writeFileSync(join(dir, "CLAUDE.md"), "user notes");

		const { configureClaudeCode } = await import("@/setup.js");
		const results = configureClaudeCode("sk-new");

		const dirResult = results.find((r) => r.kind === "claude-dir");
		expect(dirResult?.backupPath).toBe(backupDir);
		expect(existsSync(join(backupDir, "settings.json"))).toBe(true);
		expect(existsSync(join(backupDir, "CLAUDE.md"))).toBe(true);

		const backup = JSON.parse(
			readFileSync(join(backupDir, "settings.json"), "utf-8"),
		);
		expect(backup.otherKey).toBe("keep");
		expect(backup.env.ANTHROPIC_API_KEY).toBe("old");

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.otherKey).toBeUndefined();
		expect(config.env.FOO).toBeUndefined();
		expect(config.env.ANTHROPIC_API_KEY).toBe("sk-new");
	});

	test("preserves a pre-existing .claude backup across repeated runs", async () => {
		const dir = join(tempDir, ".claude");
		const backupDir = join(tempDir, ".claude.backup");
		mkdirSync(backupDir, { recursive: true });
		writeFileSync(join(backupDir, "marker.txt"), "original");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ env: { ANTHROPIC_API_KEY: "prev-codev-run" } }),
		);

		const { configureClaudeCode } = await import("@/setup.js");
		configureClaudeCode("sk-new");

		expect(readFileSync(join(backupDir, "marker.txt"), "utf-8")).toBe(
			"original",
		);
	});

	test("overwrites pre-existing .claude backup when claude-dir is in overwriteBackups", async () => {
		const dir = join(tempDir, ".claude");
		const backupDir = join(tempDir, ".claude.backup");
		mkdirSync(backupDir, { recursive: true });
		writeFileSync(join(backupDir, "stale.txt"), "old");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "fresh.txt"), "new");

		const { configureClaudeCode } = await import("@/setup.js");
		configureClaudeCode("sk-new", {
			overwriteBackups: new Set(["claude-dir"]),
		});

		expect(existsSync(join(backupDir, "stale.txt"))).toBe(false);
		expect(existsSync(join(backupDir, "fresh.txt"))).toBe(true);
	});
});

describe("configureOpenCode", () => {
	test("creates ~/.config/opencode/opencode.json with netmind provider when file does not exist", async () => {
		const { configureOpenCode } = await import("@/setup.js");
		configureOpenCode("sk-xyz");

		const filePath = join(tempDir, ".config", "opencode", "opencode.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.$schema).toBe("https://opencode.ai/config.json");
		expect(config.provider.netmind.npm).toBe("@ai-sdk/openai-compatible");
		expect(config.provider.netmind.options.baseURL).toBe(
			"https://netmind.viettel.vn/gateway/v1",
		);
		expect(config.provider.netmind.options.apiKey).toBe("sk-xyz");
		expect(config.provider.netmind.models.MiniMax.name).toBe("MiniMax");
	});

	test("does not touch ~/.claude.json (OpenCode-only install)", async () => {
		const { configureOpenCode } = await import("@/setup.js");
		configureOpenCode("sk-xyz");

		expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
	});

	test("replaces existing opencode.json and backs up the directory", async () => {
		const dir = join(tempDir, ".config", "opencode");
		const backupDir = join(tempDir, ".config", "opencode.backup");
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "opencode.json");
		writeFileSync(
			filePath,
			JSON.stringify({
				someSetting: "keep",
				provider: { other: { name: "Other" } },
			}),
		);

		const { configureOpenCode } = await import("@/setup.js");
		const results = configureOpenCode("sk-new");

		expect(results[0]?.backupPath).toBe(backupDir);
		const backup = JSON.parse(
			readFileSync(join(backupDir, "opencode.json"), "utf-8"),
		);
		expect(backup.someSetting).toBe("keep");
		expect(backup.provider.other.name).toBe("Other");

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.someSetting).toBeUndefined();
		expect(config.provider.other).toBeUndefined();
		expect(config.provider.netmind.options.apiKey).toBe("sk-new");
	});
});

describe("getBackupStatus", () => {
	test("returns only claude-dir for claude-code", async () => {
		const { getBackupStatus } = await import("@/setup.js");
		const statuses = getBackupStatus("claude-code");
		expect(statuses.map((s) => s.kind)).toEqual(["claude-dir"]);
	});

	test("returns opencode-dir for opencode", async () => {
		const { getBackupStatus } = await import("@/setup.js");
		const statuses = getBackupStatus("opencode");
		expect(statuses.map((s) => s.kind)).toEqual(["opencode-dir"]);
	});

	test("reports hasSource and hasBackup accurately", async () => {
		mkdirSync(join(tempDir, ".config", "opencode"), { recursive: true });
		writeFileSync(join(tempDir, ".config", "opencode", "opencode.json"), "{}");

		const { getBackupStatus } = await import("@/setup.js");
		const [status] = getBackupStatus("opencode");
		expect(status?.hasSource).toBe(true);
		expect(status?.hasBackup).toBe(false);
	});
});
