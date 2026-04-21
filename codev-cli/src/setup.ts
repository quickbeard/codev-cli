import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Tool = "claude-code" | "opencode";

function readJson(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

function writeJson(path: string, data: unknown) {
	writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
}

export async function bypassClaudeLogin() {
	const claudeJsonPath = join(homedir(), ".claude.json");
	const config = readJson(claudeJsonPath);

	if (!config.hasCompletedOnboarding) {
		config.hasCompletedOnboarding = true;
		writeJson(claudeJsonPath, config);
	}
}

export function configureClaudeCode(apiKey: string) {
	const dir = join(homedir(), ".claude");
	const filePath = join(dir, "settings.json");
	mkdirSync(dir, { recursive: true });

	const config = readJson(filePath);
	const existingEnv = (config.env ?? {}) as Record<string, string>;

	const merged = {
		...config,
		$schema: "https://json.schemastore.org/claude-code-settings.json",
		env: {
			...existingEnv,
			ANTHROPIC_BASE_URL: "https://netmind.viettel.vn/gateway/",
			ANTHROPIC_API_KEY: apiKey,
			ANTHROPIC_MODEL: "MiniMax",
			ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax",
			CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
		},
	};

	writeJson(filePath, merged);
}

export function configureOpenCode(apiKey: string) {
	const dir = join(homedir(), ".config", "opencode");
	const filePath = join(dir, "opencode.json");
	mkdirSync(dir, { recursive: true });

	const config = readJson(filePath);
	const existingProvider = (config.provider ?? {}) as Record<string, unknown>;

	const merged = {
		...config,
		$schema: "https://opencode.ai/config.json",
		provider: {
			...existingProvider,
			netmind: {
				npm: "@ai-sdk/openai-compatible",
				name: "NetMind Gateway",
				options: {
					baseURL: "https://netmind.viettel.vn/gateway/v1",
					apiKey,
				},
				models: {
					MiniMax: {
						name: "MiniMax",
					},
				},
			},
		},
	};

	writeJson(filePath, merged);
}
