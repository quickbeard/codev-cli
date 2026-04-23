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
import { BASE_URL } from "@/const.js";

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
		const { bypassClaudeLogin } = await import("@/configure.js");
		bypassClaudeLogin();

		const filePath = join(tempDir, ".claude.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
	});

	test("adds hasCompletedOnboarding to existing file without it", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, JSON.stringify({ someKey: "someValue" }, null, 2));

		const { bypassClaudeLogin } = await import("@/configure.js");
		bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
		expect(config.someKey).toBe("someValue");
	});

	test("does not overwrite file when hasCompletedOnboarding already set", async () => {
		const filePath = join(tempDir, ".claude.json");
		const original = { hasCompletedOnboarding: true, other: "data" };
		writeFileSync(filePath, JSON.stringify(original, null, 2));

		const { bypassClaudeLogin } = await import("@/configure.js");
		bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config).toEqual(original);
	});

	test("handles invalid JSON in existing file", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, "not valid json{{{");

		const { bypassClaudeLogin } = await import("@/configure.js");
		bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
	});

	test("does not create a .claude.json.backup", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, JSON.stringify({ someKey: "someValue" }));

		const { bypassClaudeLogin } = await import("@/configure.js");
		bypassClaudeLogin();

		expect(existsSync(`${filePath}.backup`)).toBe(false);
	});
});

describe("configureClaudeCode", () => {
	test("creates ~/.claude/settings.json with env block when file does not exist", async () => {
		const { configureClaudeCode } = await import("@/configure.js");
		configureClaudeCode("sk-abc");

		const filePath = join(tempDir, ".claude", "settings.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.$schema).toBe(
			"https://json.schemastore.org/claude-code-settings.json",
		);
		expect(config.env).toEqual({
			ANTHROPIC_BASE_URL: `${BASE_URL}gateway/`,
			ANTHROPIC_API_KEY: "sk-abc",
			ANTHROPIC_MODEL: "MiniMax",
			ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax",
			CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
		});
	});

	test("also runs bypassClaudeLogin (creates .claude.json)", async () => {
		const { configureClaudeCode } = await import("@/configure.js");
		configureClaudeCode("sk-abc");

		const claudeJson = join(tempDir, ".claude.json");
		expect(existsSync(claudeJson)).toBe(true);
		const config = JSON.parse(readFileSync(claudeJson, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
	});

	test("replaces existing settings.json and backs up the file", async () => {
		const dir = join(tempDir, ".claude");
		const filePath = join(dir, "settings.json");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify({
				otherKey: "keep",
				env: { FOO: "bar", ANTHROPIC_API_KEY: "old" },
			}),
		);

		const { configureClaudeCode } = await import("@/configure.js");
		const results = configureClaudeCode("sk-new");

		const result = results.find((r) => r.kind === "claude-settings");
		expect(result?.backupPath).toBe(backupPath);
		expect(existsSync(backupPath)).toBe(true);

		const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
		expect(backup.otherKey).toBe("keep");
		expect(backup.env.ANTHROPIC_API_KEY).toBe("old");

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.otherKey).toBeUndefined();
		expect(config.env.FOO).toBeUndefined();
		expect(config.env.ANTHROPIC_API_KEY).toBe("sk-new");
	});

	test("does not touch unrelated files in ~/.claude", async () => {
		const dir = join(tempDir, ".claude");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: {} }));
		writeFileSync(join(dir, "CLAUDE.md"), "user notes");

		const { configureClaudeCode } = await import("@/configure.js");
		configureClaudeCode("sk-new");

		expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("user notes");
		expect(existsSync(join(dir, "CLAUDE.md.backup"))).toBe(false);
	});

	test("preserves a pre-existing settings.json backup across repeated runs", async () => {
		const dir = join(tempDir, ".claude");
		const filePath = join(dir, "settings.json");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(backupPath, JSON.stringify({ marker: "original" }));
		writeFileSync(
			filePath,
			JSON.stringify({ env: { ANTHROPIC_API_KEY: "prev-codev-run" } }),
		);

		const { configureClaudeCode } = await import("@/configure.js");
		configureClaudeCode("sk-new");

		const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
		expect(backup.marker).toBe("original");
	});

	test("overwrites pre-existing settings.json backup when claude-settings is in overwriteBackups", async () => {
		const dir = join(tempDir, ".claude");
		const filePath = join(dir, "settings.json");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(backupPath, JSON.stringify({ marker: "stale" }));
		writeFileSync(filePath, JSON.stringify({ marker: "fresh" }));

		const { configureClaudeCode } = await import("@/configure.js");
		configureClaudeCode("sk-new", {
			overwriteBackups: new Set(["claude-settings"]),
		});

		const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
		expect(backup.marker).toBe("fresh");
	});
});

describe("configureOpenCode", () => {
	test("creates ~/.config/opencode/opencode.json with aigateway provider when file does not exist", async () => {
		const { configureOpenCode } = await import("@/configure.js");
		configureOpenCode("sk-xyz");

		const filePath = join(tempDir, ".config", "opencode", "opencode.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.$schema).toBe("https://opencode.ai/config.json");
		expect(config.provider.aigateway.npm).toBe("@ai-sdk/openai-compatible");
		expect(config.provider.aigateway.options.baseURL).toBe(
			`${BASE_URL}gateway/v1`,
		);
		expect(config.provider.aigateway.options.apiKey).toBe("sk-xyz");
		expect(config.provider.aigateway.models.MiniMax.name).toBe("MiniMax");
	});

	test("does not touch ~/.claude.json (OpenCode-only install)", async () => {
		const { configureOpenCode } = await import("@/configure.js");
		configureOpenCode("sk-xyz");

		expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
	});

	test("replaces existing opencode.json and backs up the file", async () => {
		const dir = join(tempDir, ".config", "opencode");
		const filePath = join(dir, "opencode.json");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify({
				someSetting: "keep",
				provider: { other: { name: "Other" } },
			}),
		);

		const { configureOpenCode } = await import("@/configure.js");
		const results = configureOpenCode("sk-new");

		expect(results[0]?.backupPath).toBe(backupPath);
		const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
		expect(backup.someSetting).toBe("keep");
		expect(backup.provider.other.name).toBe("Other");

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.someSetting).toBeUndefined();
		expect(config.provider.other).toBeUndefined();
		expect(config.provider.aigateway.options.apiKey).toBe("sk-new");
	});
});

describe("getBackupStatus", () => {
	test("returns claude-settings for claude-code", async () => {
		const { getBackupStatus } = await import("@/configure.js");
		const statuses = getBackupStatus("claude-code");
		expect(statuses.map((s) => s.kind)).toEqual(["claude-settings"]);
	});

	test("returns opencode-config for opencode", async () => {
		const { getBackupStatus } = await import("@/configure.js");
		const statuses = getBackupStatus("opencode");
		expect(statuses.map((s) => s.kind)).toEqual(["opencode-config"]);
	});

	test("reports hasSource and hasBackup accurately", async () => {
		mkdirSync(join(tempDir, ".config", "opencode"), { recursive: true });
		writeFileSync(join(tempDir, ".config", "opencode", "opencode.json"), "{}");

		const { getBackupStatus } = await import("@/configure.js");
		const [status] = getBackupStatus("opencode");
		expect(status?.hasSource).toBe(true);
		expect(status?.hasBackup).toBe(false);
	});
});

describe("restoreTool", () => {
	test("replaces the live Claude settings.json with the backup", async () => {
		const dir = join(tempDir, ".claude");
		const livePath = join(dir, "settings.json");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(livePath, '{"marker":"live"}');
		writeFileSync(backupPath, '{"marker":"backup"}');

		const { restoreTool } = await import("@/configure.js");
		const result = restoreTool("claude-code");

		expect(result.status).toBe("restored");
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(livePath)).toBe(true);
		const restored = JSON.parse(readFileSync(livePath, "utf-8"));
		expect(restored.marker).toBe("backup");
	});

	test("does not disturb other files in the target directory", async () => {
		const dir = join(tempDir, ".claude");
		const livePath = join(dir, "settings.json");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(livePath, '{"marker":"live"}');
		writeFileSync(backupPath, '{"marker":"backup"}');
		writeFileSync(join(dir, "CLAUDE.md"), "user notes");

		const { restoreTool } = await import("@/configure.js");
		restoreTool("claude-code");

		expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("user notes");
	});

	test("restores when no live file is present", async () => {
		const dir = join(tempDir, ".config", "opencode");
		const livePath = join(dir, "opencode.json");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(backupPath, '{"marker":"backup"}');

		const { restoreTool } = await import("@/configure.js");
		const result = restoreTool("opencode");

		expect(result.status).toBe("restored");
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(livePath)).toBe(true);
	});

	test("returns no-backup status when backup missing", async () => {
		const { restoreTool } = await import("@/configure.js");
		const result = restoreTool("claude-code");

		expect(result.status).toBe("no-backup");
		expect(result.backupPath).toBe(
			join(tempDir, ".claude", "settings.json.backup"),
		);
	});
});
