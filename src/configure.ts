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
import TOML from "@iarna/toml";
import { BASE_URL } from "@/const.js";

export type Tool = "claude-code" | "codex" | "opencode";
export type BackupKind = "claude-settings" | "codex-config" | "opencode-config";

export interface BackupStatus {
	kind: BackupKind;
	sourcePath: string;
	backupPath: string;
	hasSource: boolean;
	hasBackup: boolean;
}

export interface ConfigureResult {
	kind: BackupKind;
	sourcePath: string;
	backupPath: string | null;
}

export interface Credentials {
	apiKey: string;
	baseUrl?: string;
	model?: string;
}

// Claude Code's ANTHROPIC_BASE_URL is a server root, not an OpenAI-style /v1
// endpoint, so strip a trailing "v1" or "v1/" the user may have entered.
function normalizeClaudeBaseUrl(url: string): string {
	return url.replace(/v1\/?$/, "");
}

// OpenCode's OpenAI-compatible provider expects the /v1 endpoint. Preserve
// any trailing "v1" or "v1/" the user entered; otherwise append "/v1".
function normalizeOpenCodeBaseUrl(url: string): string {
	if (/v1\/?$/.test(url)) return url;
	return url.endsWith("/") ? `${url}v1` : `${url}/v1`;
}

const GATEWAY_BASE_URL = `${BASE_URL}gateway/`;
const GATEWAY_OPENAI_BASE_URL = `${GATEWAY_BASE_URL}v1`;
const MODEL_NAME = atob("TWluaU1heA==");

const CLAUDE_SCHEMA_URL = atob(
	"aHR0cHM6Ly9qc29uLnNjaGVtYXN0b3JlLm9yZy9jbGF1ZGUtY29kZS1zZXR0aW5ncy5qc29u",
);
const CLAUDE_K = {
	schema: atob("JHNjaGVtYQ=="),
	env: atob("ZW52"),
	baseUrl: atob("QU5USFJPUElDX0JBU0VfVVJM"),
	apiKey: atob("QU5USFJPUElDX0FQSV9LRVk="),
	model: atob("QU5USFJPUElDX01PREVM"),
	opus: atob("QU5USFJPUElDX0RFRkFVTFRfT1BVU19NT0RFTA=="),
	sonnet: atob("QU5USFJPUElDX0RFRkFVTFRfU09OTkVUX01PREVM"),
	haiku: atob("QU5USFJPUElDX0RFRkFVTFRfSEFJS1VfTU9ERUw="),
	agentTeams: atob("Q0xBVURFX0NPREVfRVhQRVJJTUVOVEFMX0FHRU5UX1RFQU1T"),
};

const CODEX_K = {
	model: atob("bW9kZWw="),
	modelProvider: atob("bW9kZWxfcHJvdmlkZXI="),
	modelProviders: atob("bW9kZWxfcHJvdmlkZXJz"),
	providerId: atob("YWlnYXRld2F5"),
	name: atob("bmFtZQ=="),
	displayName: atob("QUkgR2F0ZXdheQ=="),
	baseUrl: atob("YmFzZV91cmw="),
	wireApi: atob("d2lyZV9hcGk="),
	wireApiValue: atob("cmVzcG9uc2Vz"),
	bearerToken: atob("ZXhwZXJpbWVudGFsX2JlYXJlcl90b2tlbg=="),
};

const OPENCODE_SCHEMA_URL = atob(
	"aHR0cHM6Ly9vcGVuY29kZS5haS9jb25maWcuanNvbg==",
);
const OPENCODE_K = {
	schema: atob("JHNjaGVtYQ=="),
	provider: atob("cHJvdmlkZXI="),
	providerKey: atob("YWlnYXRld2F5"),
	npm: atob("bnBt"),
	npmPkg: atob("QGFpLXNkay9vcGVuYWktY29tcGF0aWJsZQ=="),
	name: atob("bmFtZQ=="),
	displayName: atob("QUkgR2F0ZXdheQ=="),
	options: atob("b3B0aW9ucw=="),
	baseURL: atob("YmFzZVVSTA=="),
	apiKey: atob("YXBpS2V5"),
	models: atob("bW9kZWxz"),
};

function sourcePathOf(kind: BackupKind): string {
	switch (kind) {
		case "claude-settings":
			return join(homedir(), ".claude", "settings.json");
		case "codex-config":
			return join(homedir(), ".codex", "config.toml");
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
	if (tool === "codex") {
		return [statusFor("codex-config")];
	}
	return [statusFor("opencode-config")];
}

function ensureBackup(kind: BackupKind): string | null {
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;
	if (!existsSync(sourcePath)) {
		return existsSync(backupPath) ? backupPath : null;
	}
	// Preserve any pre-existing backup — assume it's the user's original
	// pre-codev state and should not be clobbered by later runs.
	if (existsSync(backupPath)) {
		return backupPath;
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

function writeToml(path: string, data: TOML.JsonMap) {
	writeFileSync(path, TOML.stringify(data), { mode: 0o600 });
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

export function configureClaudeCode(creds: Credentials): ConfigureResult[] {
	bypassClaudeLogin();

	const backupPath = ensureBackup("claude-settings");
	const sourcePath = sourcePathOf("claude-settings");
	mkdirSync(dirname(sourcePath), { recursive: true });

	const baseUrl = creds.baseUrl
		? normalizeClaudeBaseUrl(creds.baseUrl)
		: GATEWAY_BASE_URL;
	const model = creds.model ?? MODEL_NAME;

	writeJson(sourcePath, {
		[CLAUDE_K.schema]: CLAUDE_SCHEMA_URL,
		[CLAUDE_K.env]: {
			[CLAUDE_K.baseUrl]: baseUrl,
			[CLAUDE_K.apiKey]: creds.apiKey,
			[CLAUDE_K.model]: model,
			[CLAUDE_K.opus]: model,
			[CLAUDE_K.sonnet]: model,
			[CLAUDE_K.haiku]: model,
			[CLAUDE_K.agentTeams]: "1",
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
		tool === "claude-code"
			? "claude-settings"
			: tool === "codex"
				? "codex-config"
				: "opencode-config";
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;

	if (!existsSync(backupPath)) {
		return { status: "no-backup", sourcePath, backupPath };
	}

	rmSync(sourcePath, { force: true });
	renameSync(backupPath, sourcePath);
	return { status: "restored", sourcePath, backupPath };
}

export function configureCodex(creds: Credentials): ConfigureResult[] {
	const backupPath = ensureBackup("codex-config");
	const sourcePath = sourcePathOf("codex-config");
	mkdirSync(dirname(sourcePath), { recursive: true });

	const baseUrl = creds.baseUrl
		? normalizeOpenCodeBaseUrl(creds.baseUrl)
		: GATEWAY_OPENAI_BASE_URL;
	const model = creds.model ?? MODEL_NAME;

	writeToml(sourcePath, {
		[CODEX_K.model]: model,
		[CODEX_K.modelProvider]: CODEX_K.providerId,
		[CODEX_K.modelProviders]: {
			[CODEX_K.providerId]: {
				[CODEX_K.name]: CODEX_K.displayName,
				[CODEX_K.baseUrl]: baseUrl,
				[CODEX_K.wireApi]: CODEX_K.wireApiValue,
				[CODEX_K.bearerToken]: creds.apiKey,
			},
		},
	});

	return [{ kind: "codex-config", sourcePath, backupPath }];
}

export function configureOpenCode(creds: Credentials): ConfigureResult[] {
	const backupPath = ensureBackup("opencode-config");
	const sourcePath = sourcePathOf("opencode-config");
	mkdirSync(dirname(sourcePath), { recursive: true });

	const baseUrl = creds.baseUrl
		? normalizeOpenCodeBaseUrl(creds.baseUrl)
		: GATEWAY_OPENAI_BASE_URL;
	const model = creds.model ?? MODEL_NAME;

	writeJson(sourcePath, {
		[OPENCODE_K.schema]: OPENCODE_SCHEMA_URL,
		[OPENCODE_K.provider]: {
			[OPENCODE_K.providerKey]: {
				[OPENCODE_K.npm]: OPENCODE_K.npmPkg,
				[OPENCODE_K.name]: OPENCODE_K.displayName,
				[OPENCODE_K.options]: {
					[OPENCODE_K.baseURL]: baseUrl,
					[OPENCODE_K.apiKey]: creds.apiKey,
				},
				[OPENCODE_K.models]: {
					[model]: {
						[OPENCODE_K.name]: model,
					},
				},
			},
		},
	});

	return [{ kind: "opencode-config", sourcePath, backupPath }];
}
