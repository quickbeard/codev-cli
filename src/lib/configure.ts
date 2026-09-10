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
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import { AI_GATEWAY_OPENAI_URL, AI_GATEWAY_URL } from "@/lib/const.js";
import { logInfo } from "@/lib/log.js";
import {
	COMPACT_RESERVED,
	claudeCompactPct,
	claudeWindow,
	declaredInput,
	limitsFor,
	outputTokens,
} from "@/lib/model-limits.js";
import { codevProviderIds, resolveProvider } from "@/lib/provider.js";
import type { Agent } from "@/providers/types.js";

export type Tool =
	| "claude-code"
	| "codex"
	| "opencode"
	| "codev-code"
	| "vscode-claude-code"
	| "jetbrains-claude-code"
	| "vscode-continue"
	| "jetbrains-continue";
export type BackupKind =
	| "claude-settings"
	| "claude-json"
	| "claude-credentials"
	| "codex-config"
	| "opencode-config"
	| "codev-code-config"
	| "continue-config";

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
	// True only when this call actually wrote a new `*.backup` file. False when
	// a pre-existing backup was preserved (or when nothing existed to back up).
	created: boolean;
}

export interface Credentials {
	apiKey: string;
	baseUrl?: string;
	// The chosen default. Required at the configure-time boundary (enforced
	// via `requireModel`); optional in the type so the in-flight install
	// state can carry partial credentials before the model-choice step.
	model?: string;
	// The full list of fetched model IDs. Tools that support an explicit
	// model list (OpenCode today) get every entry; tools with a single
	// model field (Claude Code, Codex) ignore this and use only `model`.
	// Absent ⇒ treat as [model], so older call sites stay valid.
	models?: string[];
	// The provider the user named on the manual path. Absent ⇒ SSO-issued key,
	// which gets the built-in AIGW identity (lib/provider.ts).
	providerId?: string;
	providerName?: string;
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

function requireModel(creds: Credentials): string {
	if (!creds.model) {
		throw new Error("Credentials.model is required");
	}
	return creds.model;
}

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
	autoCompactWindow: atob("Q0xBVURFX0NPREVfQVVUT19DT01QQUNUX1dJTkRPVw=="),
	autoCompactPct: atob("Q0xBVURFX0FVVE9DT01QQUNUX1BDVF9PVkVSUklERQ=="),
};

const CODEX_K = {
	model: atob("bW9kZWw="),
	modelProvider: atob("bW9kZWxfcHJvdmlkZXI="),
	modelContextWindow: atob("bW9kZWxfY29udGV4dF93aW5kb3c="),
	autoCompactTokenLimit: atob("bW9kZWxfYXV0b19jb21wYWN0X3Rva2VuX2xpbWl0"),
	modelProviders: atob("bW9kZWxfcHJvdmlkZXJz"),
	name: atob("bmFtZQ=="),
	baseUrl: atob("YmFzZV91cmw="),
	wireApi: atob("d2lyZV9hcGk="),
	wireApiValue: atob("cmVzcG9uc2Vz"),
	bearerToken: atob("ZXhwZXJpbWVudGFsX2JlYXJlcl90b2tlbg=="),
};

// Exported for lib/codegraph.ts: the fork keeps upstream's schema URL (its
// DIVERGENCES list marks it NOT renamed), and the CoDev Code MCP shim seeds
// the same $schema stub the agent itself writes on first run.
export const OPENCODE_SCHEMA_URL = atob(
	"aHR0cHM6Ly9vcGVuY29kZS5haS9jb25maWcuanNvbg==",
);
const OPENCODE_K = {
	schema: atob("JHNjaGVtYQ=="),
	provider: atob("cHJvdmlkZXI="),
	npm: atob("bnBt"),
	npmPkg: atob("QGFpLXNkay9vcGVuYWktY29tcGF0aWJsZQ=="),
	name: atob("bmFtZQ=="),
	options: atob("b3B0aW9ucw=="),
	baseURL: atob("YmFzZVVSTA=="),
	apiKey: atob("YXBpS2V5"),
	models: atob("bW9kZWxz"),
	// Top-level default-model pin (`"<provider>/<model>"`). Never written; the
	// writer removes a CoDev-authored one left by an older hub.
	model: atob("bW9kZWw="),
	recent: atob("cmVjZW50"),
	providerID: atob("cHJvdmlkZXJJRA=="),
	modelID: atob("bW9kZWxJRA=="),
	attachment: atob("YXR0YWNobWVudA=="),
	modalities: atob("bW9kYWxpdGllcw=="),
	input: atob("aW5wdXQ="),
	text: atob("dGV4dA=="),
	image: atob("aW1hZ2U="),
	limit: atob("bGltaXQ="),
	context: atob("Y29udGV4dA=="),
	// Same literal as `input` above, which names the modalities key. Kept as its
	// own entry because the two are unrelated: this one is the compaction
	// budget, that one is a media type list.
	inputLimit: atob("aW5wdXQ="),
	output: atob("b3V0cHV0"),
	compaction: atob("Y29tcGFjdGlvbg=="),
	auto: atob("YXV0bw=="),
	reserved: atob("cmVzZXJ2ZWQ="),
	// CoDev Code auth-store entry fields (writeCodevCodeAuthEntry):
	// `{ "<provider id>": { type: "api", key: "sk-..." } }`.
	authType: atob("dHlwZQ=="),
	authTypeApi: atob("YXBp"),
	authKey: atob("a2V5"),
};

// The base URL CoDev writes to each tool's config. Read back at export time so
// the session comment (markdown.ts) can embed base_url, enabling the worker to
// determine internal vs external model usage without any env-var timing tricks.
//
// Three patterns, one per tool:
//   Claude Code → settings.json → env.ANTHROPIC_BASE_URL
//   Codex       → config.toml   → model_providers.<provider>.base_url
//   OpenCode    → opencode.json → provider.<provider>.options.baseURL
//
// <provider> is the AIGW default for SSO-issued keys, or the id derived from
// the name the user typed on the manual path — so it's resolved at read time
// against codevProviderIds() rather than a fixed key.
//
// Returns undefined when the file is absent, not CoDev-managed, or unreadable.

export interface AgentConfigResult {
	baseUrl?: string;
}

export function readAgentConfig(agent: Agent): AgentConfigResult {
	switch (agent) {
		case "claude-code":
			return readClaudeCodeConfig();
		case "codex":
			return readCodexConfig();
		case "opencode":
			return readOpenCodeConfig("opencode-config");
		case "codev-code":
			return readOpenCodeConfig("codev-code-config");
	}
}

// Internal helpers follow. All throw on malformed JSON/TOML so callers that
// encounter genuinely old/corrupt configs see a clear error rather than silently
// returning undefined.

function readClaudeCodeConfig(): AgentConfigResult {
	const path = sourcePathOf("claude-settings");
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		// Guard: skip files CoDev did not write (no ANTHROPIC_DEFAULT_OPUS_MODEL).
		if (!hasNestedKey(raw, CLAUDE_K.env, CLAUDE_K.opus)) return {};
		const env = (raw as Record<string, unknown>)[CLAUDE_K.env] as Record<
			string,
			unknown
		>;
		return {
			baseUrl: (env[CLAUDE_K.baseUrl] as string) || undefined,
		};
	} catch (e) {
		throw new Error(`Failed to parse Claude Code config at ${path}: ${e}`);
	}
}

function readCodexConfig(): AgentConfigResult {
	const path = sourcePathOf("codex-config");
	if (!existsSync(path)) return {};
	try {
		const raw = TOML.parse(readFileSync(path, "utf-8")) as unknown;
		// Guard: skip non-CoDev configs (no provider we recognize).
		const providerId = firstNestedKey(
			raw,
			CODEX_K.modelProviders,
			codevProviderIds(),
		);
		if (!providerId) return {};
		const r = raw as Record<string, unknown>;
		const providers =
			(r[CODEX_K.modelProviders] as Record<string, unknown>) || {};
		const gateway = (providers[providerId] as Record<string, unknown>) || {};
		return {
			baseUrl: (gateway[CODEX_K.baseUrl as string] as string) || undefined,
		};
	} catch (e) {
		throw new Error(`Failed to parse Codex config at ${path}: ${e}`);
	}
}

// Both agents accept .json and .jsonc, and either config may legitimately be a
// .jsonc (see openCodeConfigPath). Parse the superset so a comment or a trailing
// comma can't throw — matching how the agents themselves read it. Still throws
// on genuinely malformed input, per the contract above.
function parseJsonc(text: string): unknown {
	const errors: ParseError[] = [];
	const value: unknown = parse(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) throw new Error("invalid JSON/JSONC");
	return value;
}

// Shared by opencode and codev-code — the fork reads the same config shape, just
// from ~/.config/codev/codev.json(c) instead of ~/.config/opencode/opencode.json.
function readOpenCodeConfig(
	kind: "opencode-config" | "codev-code-config",
): AgentConfigResult {
	const path = sourcePathOf(kind);
	if (!existsSync(path)) return {};
	try {
		const raw = parseJsonc(readFileSync(path, "utf-8"));
		// Guard: skip non-CoDev configs (no provider we recognize).
		const providerId = firstNestedKey(
			raw,
			OPENCODE_K.provider,
			codevProviderIds(),
		);
		if (!providerId) return {};
		const r = raw as Record<string, unknown>;
		const provider = (r[OPENCODE_K.provider] as Record<string, unknown>) || {};
		const gateway = (provider[providerId] as Record<string, unknown>) || {};
		const options =
			(gateway[OPENCODE_K.options as string] as Record<string, unknown>) || {};
		return {
			baseUrl: (options[OPENCODE_K.baseURL as string] as string) || undefined,
		};
	} catch (e) {
		throw new Error(`Failed to parse OpenCode config at ${path}: ${e}`);
	}
}

// Continue reads ~/.continue/config.yaml from a single shared location across
// editors (VS Code + JetBrains both load this file). We write the OpenAI-
// compatible provider shape: each fetched model becomes a top-level entry in
// `models:`, all sharing the same apiBase + apiKey. The top-level `name` field
// doubles as the marker `detectConfiguredTools()` uses to recognize CoDev-
// written Continue configs.
const CONTINUE_K = {
	name: atob("bmFtZQ=="),
	version: atob("dmVyc2lvbg=="),
	schema: atob("c2NoZW1h"),
	schemaValue: atob("djE="),
	models: atob("bW9kZWxz"),
	provider: atob("cHJvdmlkZXI="),
	providerValue: atob("b3BlbmFp"),
	model: atob("bW9kZWw="),
	apiBase: atob("YXBpQmFzZQ=="),
	apiKey: atob("YXBpS2V5"),
	defaultCompletionOptions: atob("ZGVmYXVsdENvbXBsZXRpb25PcHRpb25z"),
	contextLength: atob("Y29udGV4dExlbmd0aA=="),
	maxTokens: atob("bWF4VG9rZW5z"),
	// The config title is `CoDev (<provider name>)`, so only the prefix is
	// stable — that prefix is what isCodevContinueConfig matches on.
	configNamePrefix: atob("Q29EZXYgKA=="),
	configVersion: atob("MC4wLjE="),
};

function continueConfigName(providerName: string): string {
	return `${CONTINUE_K.configNamePrefix}${providerName})`;
}

// OpenCode and the codev-code fork share one config loader, so they share this
// hazard: each reads *both* `<base>.json` and `<base>.jsonc` from its config
// dir and deep-merges them, json first, jsonc second — so a jsonc silently wins
// leaf-by-leaf over anything we write to the json.
//
// Their own writers go through the loader's `globalConfigFile()`, which prefers
// .jsonc and *creates* one when no config exists — upstream seeds a `$schema`
// stub on any default run, and `codev configure` patches into whatever it picks.
// A user who launches the agent before `codevhub install` therefore already has
// a jsonc waiting to shadow us. Target the same file the agent would, so exactly
// one gateway block exists.
//
// The order matters, and each rule earns its place:
//  1. A `*.backup` pins the file we already configured. Without this, a jsonc
//     appearing after configure would send restore to the wrong candidate and
//     strand the backup forever.
//  2. An existing jsonc is the agent's write target, and would shadow us.
//  3. Otherwise `<base>.json` — which also keeps the agent from auto-seeding a
//     jsonc later, since `globalConfigFile()` finds `<base>.json` first and
//     leaves well enough alone.
//
// Upstream lists a third candidate, `config.json`, that we deliberately never
// target: it is merged *first*, i.e. lowest priority, so writing there would
// leave us shadowed by both of the others.
function openCodeConfigPath(dir: string, base: string): string {
	const jsonc = join(dir, `${base}.jsonc`);
	const json = join(dir, `${base}.json`);
	for (const candidate of [jsonc, json]) {
		if (existsSync(`${candidate}.backup`)) return candidate;
	}
	return existsSync(jsonc) ? jsonc : json;
}

function sourcePathOf(kind: BackupKind): string {
	switch (kind) {
		case "claude-settings":
			return join(homedir(), ".claude", "settings.json");
		case "claude-json":
			return join(homedir(), ".claude.json");
		case "claude-credentials":
			return join(homedir(), ".claude", ".credentials.json");
		case "codex-config":
			return join(homedir(), ".codex", "config.toml");
		case "opencode-config":
			return openCodeConfigPath(
				join(homedir(), ".config", "opencode"),
				"opencode",
			);
		// The fork renamed both halves of upstream's path: the XDG app dir (its
		// `Global.Path` constant is "codev") and the config basename. Neither old
		// name is read anymore — the fork dropped the fallback.
		case "codev-code-config":
			return openCodeConfigPath(join(homedir(), ".config", "codev"), "codev");
		case "continue-config":
			return join(homedir(), ".continue", "config.yaml");
	}
}

// The one config file CoDev Code reads that CoDev also writes. Exported for
// lib/codegraph.ts's MCP shim and lib/remove.ts's unwire, so all three writers
// resolve the same `.jsonc`-vs-`.json` candidate (see openCodeConfigPath) and
// never shadow each other.
export function codevCodeConfigPath(): string {
	return sourcePathOf("codev-code-config");
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
	return [statusFor(kindForTool(tool))];
}

// Detect which AI tools currently have a CoDev-managed config on disk. Used
// by `codevhub model` to know whose configs to rewrite when the user switches
// the default model. Each marker is something CoDev distinctly writes — one of
// the known provider ids (codex/opencode, see codevProviderIds) or
// `ANTHROPIC_DEFAULT_OPUS_MODEL` (claude-code) — none of which would appear in
// a user-authored config.
//
// Continue's config file is shared across editors (VS Code + JetBrains both
// read the same ~/.continue/config.yaml), so when the marker is present we
// return `vscode-continue` as the canonical pointer rather than enumerating
// both editor tools. That keeps `codevhub model` rewriting the YAML once
// instead of twice; the resulting file is correct for both editors.
export function detectConfiguredTools(): Tool[] {
	const tools: Tool[] = [];
	if (isCodevClaudeConfig()) tools.push("claude-code");
	if (isCodevCodexConfig()) tools.push("codex");
	if (isCodevOpenCodeConfig("opencode-config")) tools.push("opencode");
	if (isCodevOpenCodeConfig("codev-code-config")) tools.push("codev-code");
	if (isCodevContinueConfig()) tools.push("vscode-continue");
	return tools;
}

function hasNestedKey(obj: unknown, outer: string, inner: string): boolean {
	if (!obj || typeof obj !== "object") return false;
	const next = (obj as Record<string, unknown>)[outer];
	if (!next || typeof next !== "object") return false;
	return inner in (next as Record<string, unknown>);
}

// Like hasNestedKey, but for the provider maps, whose key is no longer a single
// constant: returns the first candidate id present under `outer`, or null.
// Candidates are ordered most-specific-first (the saved id, then the built-ins),
// so a config carrying both a custom and a legacy entry resolves to the custom.
function firstNestedKey(
	obj: unknown,
	outer: string,
	candidates: string[],
): string | null {
	if (!obj || typeof obj !== "object") return null;
	const next = (obj as Record<string, unknown>)[outer];
	if (!next || typeof next !== "object") return null;
	const map = next as Record<string, unknown>;
	return candidates.find((id) => id in map) ?? null;
}

function isCodevClaudeConfig(): boolean {
	const path = sourcePathOf("claude-settings");
	if (!existsSync(path)) return false;
	try {
		const config = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return hasNestedKey(config, CLAUDE_K.env, CLAUDE_K.opus);
	} catch {
		return false;
	}
}

function isCodevCodexConfig(): boolean {
	const path = sourcePathOf("codex-config");
	if (!existsSync(path)) return false;
	try {
		const config = TOML.parse(readFileSync(path, "utf-8")) as unknown;
		return (
			firstNestedKey(config, CODEX_K.modelProviders, codevProviderIds()) !==
			null
		);
	} catch {
		return false;
	}
}

function isCodevOpenCodeConfig(
	kind: "opencode-config" | "codev-code-config",
): boolean {
	const path = sourcePathOf(kind);
	if (!existsSync(path)) return false;
	try {
		const config = parseJsonc(readFileSync(path, "utf-8"));
		return (
			firstNestedKey(config, OPENCODE_K.provider, codevProviderIds()) !== null
		);
	} catch {
		return false;
	}
}

// Continue's config is YAML; pulling in a YAML parser just for one substring
// check would be overkill. The top-level `name:` we emit ends in the provider
// name, so only its prefix is fixed — still distinctive enough that a substring
// search on the raw file is sufficient.
function isCodevContinueConfig(): boolean {
	const path = sourcePathOf("continue-config");
	if (!existsSync(path)) return false;
	try {
		const raw = readFileSync(path, "utf-8");
		return raw.includes(CONTINUE_K.configNamePrefix);
	} catch {
		return false;
	}
}

// ~/.claude.json has no CoDev-specific marker key — `resetClaudeAuth` writes it
// as exactly `{hasCompletedOnboarding: true}` to skip the CLI's first-run
// wizard. That whole-file shape *is* the marker: Claude Code's own
// ~/.claude.json accumulates real user state (projects, history, mcpServers),
// so anything beyond the single onboarding key belongs to the user, not us.
function isCodevClaudeJsonStub(): boolean {
	const path = sourcePathOf("claude-json");
	if (!existsSync(path)) return false;
	try {
		const config = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!config || typeof config !== "object" || Array.isArray(config)) {
			return false;
		}
		const keys = Object.keys(config);
		return (
			keys.length === 1 &&
			(config as Record<string, unknown>).hasCompletedOnboarding === true
		);
	} catch {
		return false;
	}
}

// Tools that share a config file map to the same BackupKind. Continue's two
// editor variants share ~/.continue/config.yaml; the Claude Code CLI and its
// two extension variants share ~/.claude/settings.json. Callers that iterate
// `tools` to write configs should dedupe by kind so each shared file isn't
// written more than once.
export function kindForTool(tool: Tool): BackupKind {
	switch (tool) {
		case "claude-code":
		case "vscode-claude-code":
		case "jetbrains-claude-code":
			return "claude-settings";
		case "codex":
			return "codex-config";
		case "opencode":
			return "opencode-config";
		case "codev-code":
			return "codev-code-config";
		case "vscode-continue":
		case "jetbrains-continue":
			return "continue-config";
	}
}

// Create the *.backup snapshot for `tool` without writing CoDev's config.
// Used by the install flow's "Skip configuration" path.
export function backupOnly(tool: Tool): ConfigureResult[] {
	const kind = kindForTool(tool);
	const { path, created } = ensureBackup(kind);
	return [{ kind, sourcePath: sourcePathOf(kind), backupPath: path, created }];
}

interface BackupOutcome {
	path: string | null;
	created: boolean;
}

function ensureBackup(kind: BackupKind): BackupOutcome {
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;
	if (!existsSync(sourcePath)) {
		return existsSync(backupPath)
			? { path: backupPath, created: false }
			: { path: null, created: false };
	}
	// Preserve any pre-existing backup — assume it's the user's original
	// pre-codev state and should not be clobbered by later runs.
	if (existsSync(backupPath)) {
		return { path: backupPath, created: false };
	}
	copyFileSync(sourcePath, backupPath);
	return { path: backupPath, created: true };
}

function writeJson(path: string, data: unknown) {
	writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
}

function writeToml(path: string, data: TOML.JsonMap) {
	writeFileSync(path, TOML.stringify(data), { mode: 0o600 });
	chmodSync(path, 0o600);
}

// Always-double-quote YAML scalar. Defensive: api keys can contain any byte,
// model IDs occasionally contain colons or slashes — double quotes are the
// only YAML scalar form that requires no further character-class reasoning,
// just escape `\` and `"`.
function yamlScalar(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function writeText(path: string, contents: string) {
	writeFileSync(path, contents, { mode: 0o600 });
	chmodSync(path, 0o600);
}

// Reset Claude Code's auth state so a fresh install starts cleanly under
// CoDev's gateway credentials. Two files are handled in addition to the
// settings.json snapshot taken by `configureClaudeCode`:
//
//   - `~/.claude.json` — onboarding/state file. Backed up if present, then
//     replaced with `{hasCompletedOnboarding: true}` so the CLI skips its
//     first-run wizard. (Pre-existing fields are *not* preserved; the user's
//     original is reachable via `*.backup`.)
//   - `~/.claude/.credentials.json` — CLI-managed session credentials. Backed
//     up if present, then removed so the CLI cannot reuse stale auth that
//     would conflict with the gateway API key in settings.json.
//
// Called once from `InstallApp.handleInstallDone` when any Claude tool
// (CLI or either extension) survives the install step. Returns the two
// `ConfigureResult`s so callers may log/report; the install flow currently
// ignores the return (silent operation per design).
// Back up ~/.claude.json and ~/.claude/.credentials.json without modifying
// either. Used by the install flow's finalize Phase on the "Skip
// configuration" path; resetClaudeAuth() calls this internally before its
// destructive work, so a caller that runs backupClaudeAuth() first and
// later calls resetClaudeAuth() will see the second ensureBackup() preserve
// the backup created on the first pass.
export function backupClaudeAuth(): ConfigureResult[] {
	const results: ConfigureResult[] = [];

	const jsonSource = sourcePathOf("claude-json");
	const { path: jsonBackup, created: jsonCreated } =
		ensureBackup("claude-json");
	results.push({
		kind: "claude-json",
		sourcePath: jsonSource,
		backupPath: jsonBackup,
		created: jsonCreated,
	});

	const credSource = sourcePathOf("claude-credentials");
	const { path: credBackup, created: credCreated } =
		ensureBackup("claude-credentials");
	results.push({
		kind: "claude-credentials",
		sourcePath: credSource,
		backupPath: credBackup,
		created: credCreated,
	});

	return results;
}

export function resetClaudeAuth(): ConfigureResult[] {
	const results = backupClaudeAuth();

	const jsonSource = sourcePathOf("claude-json");
	mkdirSync(dirname(jsonSource), { recursive: true });
	writeJson(jsonSource, { hasCompletedOnboarding: true });

	const credSource = sourcePathOf("claude-credentials");
	if (existsSync(credSource)) {
		rmSync(credSource, { force: true });
	}

	return results;
}

export function configureClaudeCode(creds: Credentials): ConfigureResult[] {
	const { path: backupPath, created } = ensureBackup("claude-settings");
	const sourcePath = sourcePathOf("claude-settings");
	mkdirSync(dirname(sourcePath), { recursive: true });

	const baseUrl = creds.baseUrl
		? normalizeClaudeBaseUrl(creds.baseUrl)
		: AI_GATEWAY_URL();
	const model = requireModel(creds);
	// Claude Code pins one model (ANTHROPIC_MODEL, just below), so its window
	// and trigger are simply that model's — no reconciling across a model list
	// the way the OpenCode family needs.
	//
	// It is also the one agent that will not accept an arbitrary window: it
	// clamps to what it believes the model's native window is (200000 for
	// anything it doesn't recognize, i.e. all of them) and caps the trigger at
	// 80% of that. claudeWindow/claudeCompactPct encode both ceilings, and the
	// window is omitted entirely when pinning it would disable compaction.
	const limits = limitsFor(model);
	const claudeCompactWindow = claudeWindow(limits);

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
			// Env-var values are strings; the window/percentage are numeric.
			...(claudeCompactWindow !== null
				? { [CLAUDE_K.autoCompactWindow]: String(claudeCompactWindow) }
				: {}),
			[CLAUDE_K.autoCompactPct]: String(claudeCompactPct(limits)),
		},
	});

	return [{ kind: "claude-settings", sourcePath, backupPath, created }];
}

// Does the live file at `kind` look like something CoDev wrote? Gates the
// destructive branch of `restoreKind`, so a `false` must always mean "leave it
// alone". Each detector re-derives its own path via `sourcePathOf` and answers
// `false` for a missing or unparseable file, which is the conservative default
// we want: a config we can't attribute is one we don't delete.
//
// The two auth files have no marker key of their own:
//   - `claude-json` — matched by whole-file shape (see isCodevClaudeJsonStub).
//   - `claude-credentials` — CoDev never *writes* this file, only removes it.
//     So a live one with no backup can only be a login that happened after
//     CoDev configured Claude; it's ours to clear. Worst case the user
//     re-authenticates — no data is lost.
//
// Deliberately no cross-kind inference (e.g. reading settings.json to decide
// the credentials' fate): `restoreTool` restores claude-settings *first*, which
// erases that marker, so the answer would depend on iteration order.
function isCodevAuthored(kind: BackupKind): boolean {
	switch (kind) {
		case "claude-settings":
			return isCodevClaudeConfig();
		case "claude-json":
			return isCodevClaudeJsonStub();
		case "claude-credentials":
			return true;
		case "codex-config":
			return isCodevCodexConfig();
		case "opencode-config":
		case "codev-code-config":
			return isCodevOpenCodeConfig(kind);
		case "continue-config":
			return isCodevContinueConfig();
	}
}

export type RestoreStatus = "restored" | "deleted" | "kept-live" | "noop";

export interface RestoreResult {
	status: RestoreStatus;
	sourcePath: string;
	backupPath: string;
	// Set on `deleted` only, and only when the file was removed *despite* not
	// looking CoDev-authored — i.e. `force` overrode the gate. Lets callers say
	// what actually happened instead of claiming CoDev wrote the file.
	forced?: boolean;
}

// "Make this file look pre-CoDev." Four terminal states:
//   - backup present → swap it over the live file (the user's pre-CoDev
//     state is reinstated).
//   - no backup, live file is CoDev's → delete it. No backup means nothing
//     preceded it, so removing it *is* the pre-CoDev state.
//   - no backup, live file is the user's → leave it untouched. We can't know
//     what preceded CoDev here, so we don't destroy it.
//   - neither file exists → noop; already at pre-CoDev state.
//
// The authorship gate carries the whole safety argument, because the restore
// below *consumes* the backup (renameSync), making "no backup + live file"
// ambiguous. It can mean CoDev wrote the file from scratch — but equally that
// this is a second restore and the live file is the pristine original the first
// run just reinstated, or that the user hand-wrote a config for a tool CoDev
// never configured (both `remove` and the bare `restore` sweep visit every
// tool). Only the first case is ours to delete.
// `force` bypasses the authorship gate, so a backup-less live file is deleted
// whoever wrote it and `kept-live` never happens. It deliberately does NOT touch
// the backup branch: a `*.backup` still wins and is still restored, because that
// file is the user's pre-CoDev original and reinstating it is the whole point.
function restoreKind(kind: BackupKind, force = false): RestoreResult {
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;

	const log = (result: RestoreResult): RestoreResult => {
		logInfo(`restore ${kind}: ${result.status}`, {
			action: "restore.kind",
			extra: {
				kind,
				status: result.status,
				source_path: result.sourcePath,
				forced: result.forced === true,
			},
		});
		return result;
	};

	if (existsSync(backupPath)) {
		rmSync(sourcePath, { force: true });
		renameSync(backupPath, sourcePath);
		return log({ status: "restored", sourcePath, backupPath });
	}

	if (existsSync(sourcePath)) {
		// Evaluated even under force, so the result can tell "this was ours" apart
		// from "force took a file that wasn't" instead of misreporting the latter.
		const authored = isCodevAuthored(kind);
		if (authored || force) {
			rmSync(sourcePath, { force: true });
			return log({
				status: "deleted",
				sourcePath,
				backupPath,
				forced: !authored,
			});
		}
		return log({ status: "kept-live", sourcePath, backupPath });
	}

	return log({ status: "noop", sourcePath, backupPath });
}

// Claude tools own three files (settings.json, .claude.json,
// .credentials.json), so `restoreTool` returns an array. Single-file tools
// return a length-1 array. Callers iterate and aggregate per-tool status.
const CLAUDE_RESTORE_KINDS: BackupKind[] = [
	"claude-settings",
	"claude-json",
	"claude-credentials",
];

export function restoreTool(tool: Tool, force = false): RestoreResult[] {
	if (
		tool === "claude-code" ||
		tool === "vscode-claude-code" ||
		tool === "jetbrains-claude-code"
	) {
		// Not a bare `.map(restoreKind)`: map's second arg is the index, which
		// would land in `force` and silently force every kind after the first.
		return CLAUDE_RESTORE_KINDS.map((kind) => restoreKind(kind, force));
	}
	return [restoreKind(kindForTool(tool), force)];
}

export function configureCodex(creds: Credentials): ConfigureResult[] {
	const { path: backupPath, created } = ensureBackup("codex-config");
	const sourcePath = sourcePathOf("codex-config");
	mkdirSync(dirname(sourcePath), { recursive: true });

	const baseUrl = creds.baseUrl
		? normalizeOpenCodeBaseUrl(creds.baseUrl)
		: AI_GATEWAY_OPENAI_URL();
	const model = requireModel(creds);
	const provider = resolveProvider(creds);
	// Single-model, like Claude Code — `model` above is what Codex will run.
	const limits = limitsFor(model);

	writeToml(sourcePath, {
		[CODEX_K.model]: model,
		[CODEX_K.modelProvider]: provider.id,
		// The gateway models aren't in Codex's catalog, so Codex would otherwise
		// assume a 272K fallback window for every one of them — too large for a
		// 200K model, too small for the 1M one. Pin the real window, and give
		// the trigger as the absolute token count Codex expects.
		[CODEX_K.modelContextWindow]: limits.context,
		[CODEX_K.autoCompactTokenLimit]: limits.trigger,
		[CODEX_K.modelProviders]: {
			[provider.id]: {
				[CODEX_K.name]: provider.name,
				[CODEX_K.baseUrl]: baseUrl,
				[CODEX_K.wireApi]: CODEX_K.wireApiValue,
				[CODEX_K.bearerToken]: creds.apiKey,
			},
		},
	});

	return [{ kind: "codex-config", sourcePath, backupPath, created }];
}

export function configureContinue(creds: Credentials): ConfigureResult[] {
	const { path: backupPath, created } = ensureBackup("continue-config");
	const sourcePath = sourcePathOf("continue-config");
	mkdirSync(dirname(sourcePath), { recursive: true });

	// Continue's `openai` provider expects the OpenAI-compatible /v1 endpoint —
	// same normalization as Codex/OpenCode.
	const baseUrl = creds.baseUrl
		? normalizeOpenCodeBaseUrl(creds.baseUrl)
		: AI_GATEWAY_OPENAI_URL();
	const defaultModel = requireModel(creds);
	const allModels =
		creds.models && creds.models.length > 0 ? creds.models : [defaultModel];

	const lines: string[] = [];
	lines.push(
		`${CONTINUE_K.name}: ${yamlScalar(continueConfigName(resolveProvider(creds).name))}`,
	);
	lines.push(`${CONTINUE_K.version}: ${yamlScalar(CONTINUE_K.configVersion)}`);
	lines.push(`${CONTINUE_K.schema}: ${yamlScalar(CONTINUE_K.schemaValue)}`);
	lines.push(`${CONTINUE_K.models}:`);
	for (const id of allModels) {
		const limits = limitsFor(id);
		lines.push(`  - ${CONTINUE_K.name}: ${yamlScalar(id)}`);
		lines.push(
			`    ${CONTINUE_K.provider}: ${yamlScalar(CONTINUE_K.providerValue)}`,
		);
		lines.push(`    ${CONTINUE_K.model}: ${yamlScalar(id)}`);
		lines.push(`    ${CONTINUE_K.apiBase}: ${yamlScalar(baseUrl)}`);
		lines.push(`    ${CONTINUE_K.apiKey}: ${yamlScalar(creds.apiKey)}`);
		// Continue has no compaction of its own — it prunes history to fit
		// `contextLength`, so the window is all it needs, and there's no trigger
		// to express. Without it Continue falls back to a generic default for an
		// unrecognized model, which is the same mis-sizing the other three
		// agents get. Per-model, since Continue switches models in-IDE.
		lines.push(`    ${CONTINUE_K.defaultCompletionOptions}:`);
		lines.push(`      ${CONTINUE_K.contextLength}: ${limits.context}`);
		lines.push(`      ${CONTINUE_K.maxTokens}: ${outputTokens(limits)}`);
	}
	writeText(sourcePath, `${lines.join("\n")}\n`);

	return [{ kind: "continue-config", sourcePath, backupPath, created }];
}

export function configureOpenCode(creds: Credentials): ConfigureResult[] {
	return configureOpenCodeKind("opencode-config", creds);
}

// The codev-code fork consumes the exact same config shape; only the directory
// and filename differ (see sourcePathOf).
export function configureCodevCode(creds: Credentials): ConfigureResult[] {
	return configureOpenCodeKind("codev-code-config", creds);
}

// jsonc-parser edit formatting for the OpenCode-family writer — the same
// options lib/codegraph.ts and lib/vscode-settings.ts use, so a hub-edited
// file looks like one the agent edited itself.
const JSONC_FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

// One jsonc-parser edit; `value === undefined` removes the property. Offsets
// are computed against the text handed in, so consecutive edits must each
// start from the previous result — never batch them against the original.
function patchJsonc(
	text: string,
	path: (string | number)[],
	value: unknown,
): string {
	return applyEdits(
		text,
		modify(text, path, value, { formattingOptions: JSONC_FORMATTING }),
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

// Patch CoDev's entries into an OpenCode-family config IN PLACE, the way the
// agent writes its own config (`Config.updateGlobal` PATCHes the file through
// jsonc-parser, never rewrites it). CoDev Code is a standalone product now:
// its TUI connects custom providers, its desktop app writes theme/keybind/
// permission settings, users keep comments in codev.jsonc — and this writer
// runs on every gateway-key auto-refresh (refresh.ts) and `codevhub model`
// switch, not just at install. The previous whole-file replace silently
// deleted all of that on each run (only `mcp` was carried over, after the
// CodeGraph wiring got wiped once). Everything not listed here is untouched.
//
// What CoDev owns and rewrites:
//   - `$schema`: seeded when absent (the agent's own first-run stub does the
//     same); an existing value is left alone.
//   - `compaction.auto` / `compaction.reserved`: one global reserve for every
//     model in the map — OpenCode's schema has no per-model compaction block.
//     Each model's own trigger comes from its `limit.input`, sized against
//     exactly this number (see declaredInput). Sibling compaction keys (e.g.
//     `prune`) are the user's and survive.
//   - `provider.<id>`: replaced wholesale, so stale models and any inline
//     `options.apiKey` an older hub wrote are gone; the agent's startup
//     migration would scrub the key anyway, but a hub must never re-add one.
//   - `provider.<other CoDev id>`: removed. The agent's own configure flow
//     can't delete (its PATCH is a deep merge), so after the AIGW rename a
//     legacy `netgate` block lingers beside the new one and the model picker
//     shows every model twice — the fork documents that "a hub-managed install
//     converges on its next hub configure/refresh". Only ids CoDev itself
//     writes (codevProviderIds) are candidates; a provider the user connected
//     in-TUI is never touched.
//   - top-level `model`: removed when it pins a CoDev provider. The pin was
//     dropped from this writer because it outranks the TUI's persisted model
//     selection on every startup (Provider defaultModel checks config first,
//     then the state dir's model.json recents), so every in-CLI switch
//     reverted on restart. A whole-file replace erased an old pin implicitly;
//     a patch has to do it on purpose. A pin on a user's own provider stays.
//
// A file that can't be edited safely — syntax errors, or a root that isn't an
// object — is replaced with a fresh one, as this writer always has: the backup
// taken by the caller still holds whatever was there.
function patchOpenCodeConfig(
	path: string,
	providerId: string,
	block: Record<string, unknown>,
): void {
	let text = existsSync(path) ? readFileSync(path, "utf-8") : "";
	const errors: ParseError[] = [];
	const parsed: unknown = parse(text, errors, {
		allowTrailingComma: true,
		allowEmptyContent: true,
	});
	const editable =
		errors.length === 0 && (parsed === undefined || isPlainObject(parsed));
	const root: Record<string, unknown> =
		editable && isPlainObject(parsed) ? parsed : {};
	if (!editable || text.trim() === "") text = "{}";

	if (root[OPENCODE_K.schema] === undefined) {
		text = patchJsonc(text, [OPENCODE_K.schema], OPENCODE_SCHEMA_URL);
	}

	const compaction = {
		[OPENCODE_K.auto]: true,
		[OPENCODE_K.reserved]: COMPACT_RESERVED,
	};
	if (isPlainObject(root[OPENCODE_K.compaction])) {
		for (const [key, value] of Object.entries(compaction)) {
			text = patchJsonc(text, [OPENCODE_K.compaction, key], value);
		}
	} else {
		text = patchJsonc(text, [OPENCODE_K.compaction], compaction);
	}

	const ids = codevProviderIds();
	const providers = root[OPENCODE_K.provider];
	if (isPlainObject(providers)) {
		text = patchJsonc(text, [OPENCODE_K.provider, providerId], block);
		for (const id of ids) {
			if (id !== providerId && id in providers) {
				text = patchJsonc(text, [OPENCODE_K.provider, id], undefined);
			}
		}
	} else {
		text = patchJsonc(text, [OPENCODE_K.provider], { [providerId]: block });
	}

	const pin = root[OPENCODE_K.model];
	if (typeof pin === "string" && ids.includes(pin.split("/")[0] ?? "")) {
		text = patchJsonc(text, [OPENCODE_K.model], undefined);
	}

	writeFileSync(path, text, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function configureOpenCodeKind(
	kind: "opencode-config" | "codev-code-config",
	creds: Credentials,
): ConfigureResult[] {
	const { path: backupPath, created } = ensureBackup(kind);
	const sourcePath = sourcePathOf(kind);
	mkdirSync(dirname(sourcePath), { recursive: true });

	const baseUrl = creds.baseUrl
		? normalizeOpenCodeBaseUrl(creds.baseUrl)
		: AI_GATEWAY_OPENAI_URL();
	const defaultModel = requireModel(creds);
	const provider = resolveProvider(creds);
	// CoDev Code gets a keyless provider block: the credential goes into the
	// agent's own auth store (its provider registry merges it back in by
	// provider id at load), so codev.json never carries the API key users were
	// copying into other tools. Credential first — a keyless config with no
	// auth entry is a provider that 401s on the first chat, so a failure here
	// must abort before the config write. The agent's startup migration scrubs
	// any inline key an older hub wrote, so this writer must never re-add one.
	// Legacy OpenCode keeps the inline key: it is being retired, and its
	// upstream auth store lives under a different app dir this hub does not
	// manage.
	const keyless = kind === "codev-code-config";
	if (keyless) writeCodevCodeAuthEntry(provider.id, creds.apiKey);
	// Fall back to [defaultModel] when `models` is unset so callers that don't
	// know about the list (e.g. older fixtures, the fallback path with no
	// fetched list) still produce a valid one-entry map. The chosen model
	// leads the map for readability, but ordering does not carry the choice —
	// the first-launch default is seeded into the agent's saved selection
	// instead (see seedOpenCodeRecentModel).
	const allModels = [
		...new Set([
			defaultModel,
			...(creds.models && creds.models.length > 0 ? creds.models : []),
		]),
	];

	// A custom-provider model with no `limit` defaults to context 0, which both
	// mis-sizes the window and disables OpenCode's auto-compaction entirely.
	// Declare each model's real window so compaction works; `output` is required
	// whenever a `limit` object is present.
	//
	// `input` is what makes the trigger per-model. OpenCode computes it as
	// `limit.input − compaction.reserved`, and falls back to
	// `limit.context − maxOutputTokens` when `input` is absent — a branch that
	// ignores `reserved` entirely. Since `reserved` is a single top-level value
	// shared by every model, `input` (= trigger + reserved, see declaredInput)
	// is the only way to land a 1M-token and a 200K-token model on their own
	// triggers from one config. `context` stays the true window, which is what
	// the TUI's "% context used" gauge divides by.
	//
	// Image input defaults to off for custom-provider models, which makes
	// OpenCode strip attached images before the request and the model reply
	// that it can't see them. Declare image support so attachments pass
	// through; for a text-only model the gateway/model then decides (reject or
	// ignore) instead of the client silently dropping the image.
	const modelsMap = Object.fromEntries(
		allModels.map((id) => {
			const limits = limitsFor(id);
			return [
				id,
				{
					[OPENCODE_K.name]: id,
					[OPENCODE_K.attachment]: true,
					[OPENCODE_K.modalities]: {
						[OPENCODE_K.input]: [OPENCODE_K.text, OPENCODE_K.image],
						[OPENCODE_K.output]: [OPENCODE_K.text],
					},
					[OPENCODE_K.limit]: {
						[OPENCODE_K.context]: limits.context,
						[OPENCODE_K.inputLimit]: declaredInput(limits),
						[OPENCODE_K.output]: outputTokens(limits),
					},
				},
			];
		}),
	);

	// No top-level `model` and nothing beyond CoDev's own entries: the install-
	// time model choice exists for Claude Code and Codex, which can only run one
	// model at a time; OpenCode and CoDev Code switch freely in-CLI
	// (docs/hub/installation), and the chosen model is seeded into their saved
	// selection instead (seedOpenCodeRecentModel, below), which decides the
	// first launch and yields to any later switch. The models-map order alone
	// can't carry the choice: with no pin and no saved selection the TUI falls
	// back to the first provider in its list — upstream's hosted Zen provider,
	// which self-registers ahead of config providers — and, within a provider,
	// to the server's own model sort, neither of which reads this map's order.
	// This is why `codevhub model` steers only Claude Code and Codex directly.
	patchOpenCodeConfig(sourcePath, provider.id, {
		[OPENCODE_K.npm]: OPENCODE_K.npmPkg,
		[OPENCODE_K.name]: provider.name,
		[OPENCODE_K.options]: {
			[OPENCODE_K.baseURL]: baseUrl,
			...(keyless ? {} : { [OPENCODE_K.apiKey]: creds.apiKey }),
		},
		[OPENCODE_K.models]: modelsMap,
	});

	seedOpenCodeRecentModel(kind, provider.id, defaultModel);

	return [{ kind, sourcePath, backupPath, created }];
}

// CoDev Code's credential store — the agent's XDG data dir, not the hub's
// ~/.codev-hub. Same XDG-override convention as openCodeStateModelPath; only
// the segment differs (data vs state).
export function codevCodeAuthPath(): string {
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg) return join(xdg, "codev", "auth.json");
	return join(homedir(), ".local", "share", "codev", "auth.json");
}

// The store also holds credentials for providers the user connected inside
// the agent themselves, so both writers below read-merge-write around the one
// entry they own. A corrupt store parses as empty — the agent itself treats
// an unparseable auth.json the same way.
function readCodevCodeAuthStore(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			return raw as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

// Atomic staged write (hub auth.ts pattern): the agent writes this file
// concurrently when the user connects a provider in-CLI, so a rename publishes
// one whole file or the other, never a torn merge; chmod 0600 before the
// rename so the published file is never readable by other users.
function writeCodevCodeAuthStore(
	path: string,
	data: Record<string, unknown>,
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
	chmodSync(path, 0o600);
}

function writeCodevCodeAuthEntry(providerId: string, apiKey: string): void {
	const path = codevCodeAuthPath();
	writeCodevCodeAuthStore(path, {
		...readCodevCodeAuthStore(path),
		[providerId]: {
			[OPENCODE_K.authType]: OPENCODE_K.authTypeApi,
			[OPENCODE_K.authKey]: apiKey,
		},
	});
}

// `codevhub remove` cleanup: drop the CoDev-owned credential entries from the
// agent's auth store, leaving providers the user connected themselves.
// Returns the removed ids; a missing store or no matching entry returns [].
export function removeCodevCodeAuthEntries(): string[] {
	const path = codevCodeAuthPath();
	const existing = readCodevCodeAuthStore(path);
	const removed = codevProviderIds().filter((id) => id in existing);
	if (removed.length === 0) return [];
	writeCodevCodeAuthStore(
		path,
		Object.fromEntries(
			Object.entries(existing).filter(([id]) => !removed.includes(id)),
		),
	);
	return removed;
}

// OpenCode-family agents persist the TUI's model selection in the XDG state
// dir (`state/model.json`, `recent` list); only the app segment differs
// between OpenCode and the codev-code fork, mirroring dbPath in
// providers/opencode.ts.
function openCodeStateModelPath(
	kind: "opencode-config" | "codev-code-config",
): string {
	const app = kind === "codev-code-config" ? "codev" : "opencode";
	const xdg = process.env.XDG_STATE_HOME;
	if (xdg) return join(xdg, app, "model.json");
	return join(homedir(), ".local", "state", app, "model.json");
}

// Seed the install-time model choice as the agent's saved selection —
// `recent[0]` in the state dir is the TUI's highest-priority startup source
// once the config carries no `model` pin, and a later in-CLI switch simply
// displaces it. Seeds ONLY when the recents list is empty or absent: this
// writer also runs on every gateway-key auto-refresh (refresh.ts) and
// `codevhub model`, and a non-empty list is a selection the user already
// made that must keep winning. Best-effort by design, like the config
// writer: a corrupt state file is replaced (the agent ignores one anyway),
// other fields (favorites, variants) are carried over, and a filesystem
// failure never fails the configure step.
function seedOpenCodeRecentModel(
	kind: "opencode-config" | "codev-code-config",
	providerId: string,
	modelId: string,
): void {
	try {
		const path = openCodeStateModelPath(kind);
		let existing: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				const raw = JSON.parse(readFileSync(path, "utf-8"));
				if (raw && typeof raw === "object" && !Array.isArray(raw)) {
					existing = raw as Record<string, unknown>;
				}
			} catch {
				// Corrupt state file: replaced below.
			}
		}
		const recent = existing[OPENCODE_K.recent];
		if (Array.isArray(recent) && recent.length > 0) return;
		mkdirSync(dirname(path), { recursive: true });
		writeJson(path, {
			...existing,
			[OPENCODE_K.recent]: [
				{ [OPENCODE_K.providerID]: providerId, [OPENCODE_K.modelID]: modelId },
			],
		});
	} catch {
		// The seed is a nicety; the config write above already succeeded.
	}
}
