import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BASE_URL } from "@/const.js";

export type Tool = "claude-code" | "opencode";
export type BackupKind = "claude-dir" | "opencode-dir";

export interface BackupStatus {
	kind: BackupKind;
	sourcePath: string;
	backupPath: string;
	hasSource: boolean;
	hasBackup: boolean;
}

export interface ConfigureOptions {
	overwriteBackups?: Set<BackupKind>;
}

export interface ConfigureResult {
	kind: BackupKind;
	sourcePath: string;
	backupPath: string | null;
}

const GATEWAY_BASE_URL = `${BASE_URL}gateway/`;
const GATEWAY_OPENAI_BASE_URL = `${GATEWAY_BASE_URL}v1`;
const MODEL_NAME = "MiniMax";

function sourcePathOf(kind: BackupKind): string {
	switch (kind) {
		case "claude-dir":
			return join(homedir(), ".claude");
		case "opencode-dir":
			return join(homedir(), ".config", "opencode");
	}
}

function statusFor(kind: BackupKind): BackupStatus {
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;
	return {
		kind,
		sourcePath,
		backupPath,
		hasSource: existsSync(sourcePath),
		hasBackup: existsSync(backupPath),
	};
}

export function getBackupStatus(tool: Tool): BackupStatus[] {
	if (tool === "claude-code") {
		return [statusFor("claude-dir")];
	}
	return [statusFor("opencode-dir")];
}

function ensureBackup(kind: BackupKind, overwrite: boolean): string | null {
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;
	if (!existsSync(sourcePath)) {
		return existsSync(backupPath) ? backupPath : null;
	}
	if (existsSync(backupPath)) {
		if (!overwrite) return backupPath;
		rmSync(backupPath, { recursive: true, force: true });
	}
	cpSync(sourcePath, backupPath, { recursive: true });
	return backupPath;
}

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

export function bypassClaudeLogin(): void {
	const claudeJsonPath = join(homedir(), ".claude.json");
	const config = readJson(claudeJsonPath);
	if (!config.hasCompletedOnboarding) {
		config.hasCompletedOnboarding = true;
		writeJson(claudeJsonPath, config);
	}
}

export function configureClaudeCode(
	apiKey: string,
	opts: ConfigureOptions = {},
): ConfigureResult[] {
	const overwrites = opts.overwriteBackups ?? new Set<BackupKind>();

	bypassClaudeLogin();

	const dirBackup = ensureBackup("claude-dir", overwrites.has("claude-dir"));
	const dirPath = sourcePathOf("claude-dir");
	mkdirSync(dirPath, { recursive: true });

	writeJson(join(dirPath, "settings.json"), {
		$schema: "https://json.schemastore.org/claude-code-settings.json",
		env: {
			ANTHROPIC_BASE_URL: GATEWAY_BASE_URL,
			ANTHROPIC_API_KEY: apiKey,
			ANTHROPIC_MODEL: MODEL_NAME,
			ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL_NAME,
			ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL_NAME,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL_NAME,
			CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
		},
	});

	return [{ kind: "claude-dir", sourcePath: dirPath, backupPath: dirBackup }];
}

export function configureOpenCode(
	apiKey: string,
	opts: ConfigureOptions = {},
): ConfigureResult[] {
	const overwrites = opts.overwriteBackups ?? new Set<BackupKind>();
	const dirBackup = ensureBackup(
		"opencode-dir",
		overwrites.has("opencode-dir"),
	);
	const dirPath = sourcePathOf("opencode-dir");
	mkdirSync(dirPath, { recursive: true });

	writeJson(join(dirPath, "opencode.json"), {
		$schema: "https://opencode.ai/config.json",
		provider: {
			netmind: {
				npm: "@ai-sdk/openai-compatible",
				name: "NetMind Gateway",
				options: {
					baseURL: GATEWAY_OPENAI_BASE_URL,
					apiKey,
				},
				models: {
					[MODEL_NAME]: {
						name: MODEL_NAME,
					},
				},
			},
		},
	});

	return [{ kind: "opencode-dir", sourcePath: dirPath, backupPath: dirBackup }];
}
