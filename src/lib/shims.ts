import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
	detectConfiguredTools,
	getBackupStatus,
	type Tool,
} from "@/lib/configure.js";

export const SHIM_AGENTS = ["claude", "opencode", "codex", "codev"] as const;
export type ShimAgent = (typeof SHIM_AGENTS)[number];

// Editor extension variants (vscode-claude-code / jetbrains-claude-code /
// vscode-continue / jetbrains-continue) are launched from inside the IDE, not
// via a CoDev PATH shim, so they have no ShimAgent. Returning null lets
// callers filter them out of shim install/uninstall flows without per-call
// special-casing.
export function toolToShimAgent(tool: Tool): ShimAgent | null {
	if (tool === "claude-code") return "claude";
	if (tool === "codex") return "codex";
	if (tool === "opencode") return "opencode";
	if (tool === "codev-code") return "codev";
	return null;
}

// Tools CoDev has touched on this machine. Used by bare `codevhub hook` so it
// shims exactly what the user picked during install, instead of unconditionally
// all three agents. Signals are unioned so every legitimate install path is
// covered:
//   - Live config carries CoDev's marker (`detectConfiguredTools`): catches the
//     full-configure path, including first-time users where no pre-existing
//     config existed to back up (so `hasBackup` alone would miss them).
//   - A `*.backup` snapshot exists: catches the "Skip configuration" path,
//     where CoDev preserved the user's pre-existing config but didn't write
//     its own (so no marker lands in the live config).
// The one case neither signal catches is "Skip configuration on a tool with
// no pre-existing config" — but there CoDev didn't modify the tool's files at
// all, so there's nothing on disk to detect.
export function detectCodevTools(): ShimAgent[] {
	const tools: Tool[] = ["claude-code", "codex", "opencode", "codev-code"];
	const configured = new Set(detectConfiguredTools());
	return tools
		.filter(
			(tool) =>
				configured.has(tool) || getBackupStatus(tool).some((s) => s.hasBackup),
		)
		.map(toolToShimAgent)
		.filter((agent): agent is ShimAgent => agent !== null);
}

const SENTINEL_START = "# >>> codev shims (managed) >>>";
const SENTINEL_END = "# <<< codev shims (managed) <<<";

export function shimDir(): string {
	return join(homedir(), ".codev-hub", "bin");
}

// Pre-0.4 hub versions wrote shims to ~/.codev/bin (now ~/.codev-hub/bin).
// Those shims exec the bare `codev` command which no longer exists, so leaving
// them on PATH makes isAgentAvailable and runAgent resolve the stale shim
// instead of the real binary.
function legacyShimDirs(): string[] {
	return [join(homedir(), ".codev", "bin")];
}

// run.ts uses this to strip our shim dir from the child's PATH so that
// `codevhub claude` -> spawn("claude") resolves the real npm-installed binary
// instead of recursing through the shim.
export function stripShimDirFromPath(
	path: string | undefined,
	sep = delimiter,
): string {
	if (!path) return "";
	const excluded = new Set([shimDir(), ...legacyShimDirs()]);
	return path
		.split(sep)
		.filter((p) => !excluded.has(p))
		.join(sep);
}

export interface ShimResult {
	shimDir: string;
	shimsWritten: ShimAgent[];
	rcFilesUpdated: string[];
	windowsUserPathUpdated: boolean;
}

function posixShimContent(agent: ShimAgent): string {
	// Strip our shim dir from PATH *inside the shim* so that whichever
	// `codevhub` resolves it (including older versions that don't filter their
	// own shim dir) won't loop back through this script when it spawns the
	// real agent.
	//
	// If the hub itself is gone (npm-uninstalled without `codevhub unhook`),
	// fall back to the real agent on the stripped PATH so the command keeps
	// working instead of dying with "codevhub: not found".
	return `#!/bin/sh
# This shim is managed by CoDev. Manual edits will be overwritten.
SHIM_DIR="$HOME/.codev-hub/bin"
new_path=""
old_ifs="$IFS"
IFS=:
set -f
for p in $PATH; do
	if [ "$p" != "$SHIM_DIR" ]; then
		new_path="\${new_path:+$new_path:}$p"
	fi
done
set +f
IFS="$old_ifs"
PATH="$new_path"
export PATH
if command -v codevhub >/dev/null 2>&1; then
	exec codevhub ${agent} "$@"
fi
exec ${agent} "$@"
`;
}

function cmdShimContent(agent: ShimAgent): string {
	// Same recursion guard as the POSIX shim: strip our shim dir from PATH so
	// older hub versions that don't filter their own shim dir don't loop. Same
	// fallback too: a missing codevhub runs the real agent directly.
	return `@echo off\r
REM This shim is managed by CoDev. Manual edits will be overwritten.\r
setlocal EnableDelayedExpansion\r
set "SHIM_DIR=%USERPROFILE%\\.codev-hub\\bin"\r
set "NEWPATH="\r
for %%P in ("%PATH:;=";"%") do (\r
\tif /I not "%%~P"=="%SHIM_DIR%" (\r
\t\tif defined NEWPATH (set "NEWPATH=!NEWPATH!;%%~P") else (set "NEWPATH=%%~P")\r
\t)\r
)\r
endlocal & set "PATH=%NEWPATH%"\r
where codevhub >nul 2>nul\r
if errorlevel 1 (\r
\t${agent} %*\r
) else (\r
\tcodevhub ${agent} %*\r
)\r
`;
}

function writeShimFiles(agents: readonly ShimAgent[]): ShimAgent[] {
	const dir = shimDir();
	mkdirSync(dir, { recursive: true });
	const written: ShimAgent[] = [];
	for (const agent of agents) {
		if (process.platform === "win32") {
			writeFileSync(join(dir, `${agent}.cmd`), cmdShimContent(agent));
		} else {
			const path = join(dir, agent);
			writeFileSync(path, posixShimContent(agent));
			chmodSync(path, 0o755);
		}
		written.push(agent);
	}
	return written;
}

// Lists agents whose shim file currently lives in ~/.codev-hub/bin. installShims
// uses this to compute the rc-file alias union so a second `codevhub install`
// for a different tool doesn't drop the first run's aliases.
export function detectInstalledShims(): ShimAgent[] {
	const dir = shimDir();
	if (!existsSync(dir)) return [];
	const installed: ShimAgent[] = [];
	for (const agent of SHIM_AGENTS) {
		const name = process.platform === "win32" ? `${agent}.cmd` : agent;
		if (existsSync(join(dir, name))) installed.push(agent);
	}
	return installed;
}

// Replaces an existing sentinel block, or appends one if not present.
function applySentinelBlock(existing: string, snippet: string): string {
	const blockRe = new RegExp(
		`${escapeRegExp(SENTINEL_START)}[\\s\\S]*?${escapeRegExp(SENTINEL_END)}\\n?`,
	);
	const block = `${SENTINEL_START}\n${snippet}${SENTINEL_END}\n`;
	if (blockRe.test(existing)) {
		// Use a function replacement so `$&`/`$1` in the snippet are not
		// interpreted as backreferences by String.replace.
		return existing.replace(blockRe, () => block);
	}
	const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	return `${existing}${prefix}${block}`;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Aliases are guarded on the shim file existing: rc blocks and live shells
// can outlive the shims (`codevhub unhook` from another terminal, an npm
// uninstall), and an unguarded alias to a missing absolute path breaks the
// command entirely ("no such file or directory") instead of letting the
// shell fall back to the real binary on PATH.
function posixShellSnippet(agents: readonly ShimAgent[]): string {
	const dir = "$HOME/.codev-hub/bin";
	const aliases = agents
		.map((a) => `[ -x "${dir}/${a}" ] && alias ${a}="${dir}/${a}"`)
		.join("\n");
	return `# Routes claude/codex/opencode/codev through codevhub so they pick up CoDev's config.
# Remove this block to disable.
export PATH="${dir}:$PATH"
${aliases}
`;
}

function fishShellSnippet(agents: readonly ShimAgent[]): string {
	const dir = "$HOME/.codev-hub/bin";
	const aliases = agents
		.map((a) => `test -x "${dir}/${a}"; and alias ${a} "${dir}/${a}"`)
		.join("\n");
	return `# Routes claude/codex/opencode/codev through codevhub so they pick up CoDev's config.
# Remove this block to disable.
fish_add_path -p ${dir}
${aliases}
`;
}

function powershellSnippet(agents: readonly ShimAgent[]): string {
	const dir = "$HOME\\.codev-hub\\bin";
	const functions = agents
		.map(
			(a) =>
				`if (Test-Path "${dir}\\${a}.cmd") { function ${a} { & "${dir}\\${a}.cmd" @args } }`,
		)
		.join("\n");
	return `# Routes claude/codex/opencode/codev through codevhub so they pick up CoDev's config.
# Remove this block to disable.
$env:PATH = "${dir}" + [IO.Path]::PathSeparator + $env:PATH
${functions}
`;
}

function updateRcFile(path: string, snippet: string, create: boolean): boolean {
	const exists = existsSync(path);
	if (!exists && !create) return false;
	const existing = exists ? readFileSync(path, "utf-8") : "";
	const next = applySentinelBlock(existing, snippet);
	if (next === existing) return false;
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, next);
	return true;
}

function patchUnixRcs(agents: readonly ShimAgent[]): string[] {
	const home = homedir();
	const updated: string[] = [];
	const snippet = posixShellSnippet(agents);
	// zsh/bash rc files: always create-or-update — they're the universal shells
	// on Unix and the user may switch into them at any time.
	for (const name of [".zshrc", ".bashrc", ".bash_profile"]) {
		const path = join(home, name);
		if (updateRcFile(path, snippet, true)) updated.push(path);
	}
	// fish: only touch if the user already has a fish config dir, to avoid
	// littering homes of users who don't use fish.
	const fishDir = join(home, ".config", "fish");
	if (existsSync(fishDir)) {
		const path = join(fishDir, "config.fish");
		if (updateRcFile(path, fishShellSnippet(agents), true)) updated.push(path);
	}
	return updated;
}

function patchWindowsProfiles(agents: readonly ShimAgent[]): string[] {
	const home = homedir();
	const snippet = powershellSnippet(agents);
	const updated: string[] = [];
	const profiles = [
		join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
		join(
			home,
			"Documents",
			"WindowsPowerShell",
			"Microsoft.PowerShell_profile.ps1",
		),
	];
	for (const path of profiles) {
		if (updateRcFile(path, snippet, true)) updated.push(path);
	}
	return updated;
}

// Reads the user-scope Windows PATH from the registry and prepends our shim dir
// if not already present. Uses PowerShell rather than `setx` to avoid setx's
// 1024-char truncation and its habit of concatenating the volatile session PATH.
function updateWindowsUserPath(): boolean {
	const dir = join(homedir(), ".codev-hub", "bin");
	const script = [
		"$ErrorActionPreference='Stop'",
		"$dir = [Environment]::GetFolderPath('UserProfile') + '\\.codev-hub\\bin'",
		"$cur = [Environment]::GetEnvironmentVariable('Path','User')",
		"if ($null -eq $cur) { $cur = '' }",
		"$parts = $cur.Split([IO.Path]::PathSeparator)",
		"if ($parts -contains $dir) { Write-Output 'unchanged'; exit 0 }",
		"$new = if ($cur.Length -gt 0) { $dir + [IO.Path]::PathSeparator + $cur } else { $dir }",
		"[Environment]::SetEnvironmentVariable('Path', $new, 'User')",
		"Write-Output 'updated'",
	].join("; ");
	try {
		const out = execFileSync(
			"powershell",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ encoding: "utf-8" },
		);
		return out.trim() === "updated";
	} catch {
		// Fall back to a best-effort setx if PowerShell isn't available.
		try {
			execFileSync("setx", ["PATH", `${dir};%PATH%`], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}
}

export function activationHint(): string {
	if (process.platform === "win32") {
		return "Restart your terminal to apply.";
	}
	return "Run `exec $SHELL` to apply (or open a new terminal).";
}

export function installShims(
	agents: readonly ShimAgent[] = SHIM_AGENTS,
): ShimResult {
	const shimsWritten = writeShimFiles(agents);
	// rc-file aliases reflect every shim on disk (just-written ∪ pre-existing
	// from earlier installs), so a second `codevhub install` that picks a
	// different tool doesn't orphan the first run's aliases.
	const aliasAgents = detectInstalledShims();
	const rcFilesUpdated: string[] = [];
	let windowsUserPathUpdated = false;
	if (process.platform === "win32") {
		rcFilesUpdated.push(...patchWindowsProfiles(aliasAgents));
		windowsUserPathUpdated = updateWindowsUserPath();
	} else {
		rcFilesUpdated.push(...patchUnixRcs(aliasAgents));
	}
	return {
		shimDir: shimDir(),
		shimsWritten,
		rcFilesUpdated,
		windowsUserPathUpdated,
	};
}

// Heals shims written by older hub versions. Two known generations: pre-0.4
// shims re-exec the bare `codev` command (which now belongs to CoDev Code,
// the agent), and pre-fallback shims die when codevhub itself was
// uninstalled. Any shim whose body differs from the current template is
// rewritten, and the rc-file alias blocks are refreshed with it. Called on
// every hub startup; the common case (no shim dir, or already-current shims)
// does no writes. Returns true when anything was repaired.
export function repairShims(): boolean {
	const dir = shimDir();
	if (!existsSync(dir)) return false;
	// `codev-code` is the pre-0.4 shim name for the agent; it carries forward
	// as the `codev` shim.
	const legacyPath = join(
		dir,
		process.platform === "win32" ? "codev-code.cmd" : "codev-code",
	);
	const hadLegacy = existsSync(legacyPath);
	if (hadLegacy) rmSync(legacyPath, { force: true });
	const installed = detectInstalledShims();
	const stale = installed.some((agent) => {
		const name = process.platform === "win32" ? `${agent}.cmd` : agent;
		const current =
			process.platform === "win32"
				? cmdShimContent(agent)
				: posixShimContent(agent);
		return readFileSync(join(dir, name), "utf-8") !== current;
	});
	if (!hadLegacy && !stale) return false;
	const agents =
		hadLegacy && !installed.includes("codev")
			? [...installed, "codev" as const]
			: installed;
	if (agents.length > 0) installShims(agents);
	return true;
}

export interface UninstallResult {
	shimDir: string;
	shimsRemoved: string[];
	rcFilesUpdated: string[];
	windowsUserPathUpdated: boolean;
}

function removeShimFiles(): string[] {
	const dir = shimDir();
	if (!existsSync(dir)) return [];
	const removed: string[] = [];
	// `codev-code` is the pre-0.4 name of the `codev` shim; sweep it too so
	// unhooking cleans up installs made by older hub versions.
	for (const agent of [...SHIM_AGENTS, "codev-code"]) {
		const name = process.platform === "win32" ? `${agent}.cmd` : agent;
		const path = join(dir, name);
		if (existsSync(path)) {
			rmSync(path, { force: true });
			removed.push(path);
		}
	}
	// Remove the shim dir if it's now empty. Leave $HOME/.codev-hub intact since
	// other codev state lives there (auth.json, logs/).
	try {
		rmdirSync(dir);
	} catch {
		// Non-empty (e.g. user added their own files) — leave it.
	}
	return removed;
}

function stripSentinelBlock(existing: string): string {
	const blockRe = new RegExp(
		`${escapeRegExp(SENTINEL_START)}[\\s\\S]*?${escapeRegExp(SENTINEL_END)}\\n?`,
	);
	return existing.replace(blockRe, "");
}

function unpatchRcFile(path: string): boolean {
	if (!existsSync(path)) return false;
	const existing = readFileSync(path, "utf-8");
	const next = stripSentinelBlock(existing);
	if (next === existing) return false;
	writeFileSync(path, next);
	return true;
}

function unpatchUnixRcs(): string[] {
	const home = homedir();
	const updated: string[] = [];
	for (const name of [".zshrc", ".bashrc", ".bash_profile"]) {
		if (unpatchRcFile(join(home, name))) updated.push(join(home, name));
	}
	const fishPath = join(home, ".config", "fish", "config.fish");
	if (unpatchRcFile(fishPath)) updated.push(fishPath);
	return updated;
}

function unpatchWindowsProfiles(): string[] {
	const home = homedir();
	const updated: string[] = [];
	const profiles = [
		join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
		join(
			home,
			"Documents",
			"WindowsPowerShell",
			"Microsoft.PowerShell_profile.ps1",
		),
	];
	for (const path of profiles) {
		if (unpatchRcFile(path)) updated.push(path);
	}
	return updated;
}

// Removes our shim dir from the user-scope Windows PATH. Best-effort: returns
// false if PowerShell is unavailable or the entry wasn't present.
function removeFromWindowsUserPath(): boolean {
	const script = [
		"$ErrorActionPreference='Stop'",
		"$dir = [Environment]::GetFolderPath('UserProfile') + '\\.codev-hub\\bin'",
		"$cur = [Environment]::GetEnvironmentVariable('Path','User')",
		"if ($null -eq $cur -or $cur.Length -eq 0) { Write-Output 'unchanged'; exit 0 }",
		"$sep = [IO.Path]::PathSeparator",
		"$parts = $cur.Split($sep) | Where-Object { $_ -ne $dir }",
		"$new = [string]::Join($sep, $parts)",
		"if ($new -eq $cur) { Write-Output 'unchanged'; exit 0 }",
		"[Environment]::SetEnvironmentVariable('Path', $new, 'User')",
		"Write-Output 'updated'",
	].join("; ");
	try {
		const out = execFileSync(
			"powershell",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ encoding: "utf-8" },
		);
		return out.trim() === "updated";
	} catch {
		return false;
	}
}

export function uninstallShims(): UninstallResult {
	const shimsRemoved = removeShimFiles();
	const rcFilesUpdated: string[] = [];
	let windowsUserPathUpdated = false;
	if (process.platform === "win32") {
		rcFilesUpdated.push(...unpatchWindowsProfiles());
		windowsUserPathUpdated = removeFromWindowsUserPath();
	} else {
		rcFilesUpdated.push(...unpatchUnixRcs());
	}
	return {
		shimDir: shimDir(),
		shimsRemoved,
		rcFilesUpdated,
		windowsUserPathUpdated,
	};
}
