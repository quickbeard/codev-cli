import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BASE_URL } from "@/const.js";

export type Tool = "claude-code" | "opencode";
export type BackupKind = "claude-settings" | "opencode-config";

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
const MODEL_NAME = atob("TWluaU1heA==");

function sourcePathOf(kind: BackupKind): string {
	switch (kind) {
		case "claude-settings":
			return join(homedir(), ".claude", "settings.json");
		case "opencode-config":
			return join(homedir(), ".config", "opencode", "opencode.json");
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
		return [statusFor("claude-settings")];
	}
	return [statusFor("opencode-config")];
}

function ensureBackup(kind: BackupKind, overwrite: boolean): string | null {
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;
	if (!existsSync(sourcePath)) {
		return existsSync(backupPath) ? backupPath : null;
	}
	if (existsSync(backupPath)) {
		if (!overwrite) return backupPath;
		rmSync(backupPath, { force: true });
	}
	copyFileSync(sourcePath, backupPath);
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

	const backupPath = ensureBackup(
		"claude-settings",
		overwrites.has("claude-settings"),
	);
	const sourcePath = sourcePathOf("claude-settings");
	mkdirSync(dirname(sourcePath), { recursive: true });

	writeJson(sourcePath, {
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

	return [{ kind: "claude-settings", sourcePath, backupPath }];
}

export type RestoreStatus = "restored" | "no-backup";

export interface RestoreResult {
	status: RestoreStatus;
	sourcePath: string;
	backupPath: string;
}

export function restoreTool(tool: Tool): RestoreResult {
	const kind: BackupKind =
		tool === "claude-code" ? "claude-settings" : "opencode-config";
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;

	if (!existsSync(backupPath)) {
		return { status: "no-backup", sourcePath, backupPath };
	}

	rmSync(sourcePath, { force: true });
	renameSync(backupPath, sourcePath);
	return { status: "restored", sourcePath, backupPath };
}

export function configureOpenCode(
	apiKey: string,
	opts: ConfigureOptions = {},
): ConfigureResult[] {
	const overwrites = opts.overwriteBackups ?? new Set<BackupKind>();
	const backupPath = ensureBackup(
		"opencode-config",
		overwrites.has("opencode-config"),
	);
	const sourcePath = sourcePathOf("opencode-config");
	mkdirSync(dirname(sourcePath), { recursive: true });

	writeJson(sourcePath, {
		$schema: "https://opencode.ai/config.json",
		provider: {
			aigateway: {
				npm: "@ai-sdk/openai-compatible",
				name: "AI Gateway",
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

	return [{ kind: "opencode-config", sourcePath, backupPath }];
}
