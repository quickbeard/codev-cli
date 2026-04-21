import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
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
		await bypassClaudeLogin();

		const filePath = join(tempDir, ".claude.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
	});

	test("adds hasCompletedOnboarding to existing file without it", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, JSON.stringify({ someKey: "someValue" }, null, 2));

		const { bypassClaudeLogin } = await import("@/setup.js");
		await bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
		expect(config.someKey).toBe("someValue");
	});

	test("does not overwrite file when hasCompletedOnboarding already set", async () => {
		const filePath = join(tempDir, ".claude.json");
		const original = { hasCompletedOnboarding: true, other: "data" };
		writeFileSync(filePath, JSON.stringify(original, null, 2));

		const { bypassClaudeLogin } = await import("@/setup.js");
		await bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config).toEqual(original);
	});

	test("handles invalid JSON in existing file", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, "not valid json{{{");

		const { bypassClaudeLogin } = await import("@/setup.js");
		await bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
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

	test("merges with existing settings.json preserving unrelated keys and env vars", async () => {
		const dir = join(tempDir, ".claude");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "settings.json");
		writeFileSync(
			filePath,
			JSON.stringify({
				otherKey: "keep",
				env: { FOO: "bar", ANTHROPIC_API_KEY: "old" },
			}),
		);

		const { configureClaudeCode } = await import("@/setup.js");
		configureClaudeCode("sk-new");

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.otherKey).toBe("keep");
		expect(config.env.FOO).toBe("bar");
		expect(config.env.ANTHROPIC_API_KEY).toBe("sk-new");
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

	test("merges with existing opencode.json preserving unrelated keys and other providers", async () => {
		const dir = join(tempDir, ".config", "opencode");
		const { mkdirSync } = await import("node:fs");
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
		configureOpenCode("sk-new");

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.someSetting).toBe("keep");
		expect(config.provider.other.name).toBe("Other");
		expect(config.provider.netmind.options.apiKey).toBe("sk-new");
	});
});
