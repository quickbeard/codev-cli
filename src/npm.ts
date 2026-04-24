import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@/configure.js";

export const PKG: Record<Tool, string> = {
	"claude-code": "@anthropic-ai/claude-code",
	opencode: "opencode-ai",
};

export const CLI: Record<Tool, string> = {
	"claude-code": "claude",
	opencode: "opencode",
};

// On Windows, `npm` is a `.cmd` shim that `execFile` can't resolve without a
// shell. Enabling the shell on win32 lets the OS find `npm.cmd`/`npx.cmd`.
export const USE_SHELL = process.platform === "win32";

export interface ExecResult {
	stdout: string;
	stderr: string;
	error: NodeJS.ErrnoException | null;
}

export function execAsync(file: string, args: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(file, args, { shell: USE_SHELL }, (error, stdout, stderr) => {
			resolve({
				stdout: stdout?.toString() ?? "",
				stderr: stderr?.toString() ?? "",
				error: error as NodeJS.ErrnoException | null,
			});
		});
	});
}

export async function installPackage(pkg: string): Promise<string | null> {
	// `--include=optional` defends against a global `--omit=optional` config
	// that would skip Claude Code's platform-native binary.
	// `--foreground-scripts` makes the postinstall log visible if it fails.
	// Both are per-invocation flags; nothing on disk outside the package's
	// own install location is touched.
	const r = await execAsync("npm", [
		"install",
		"-g",
		pkg,
		"--include=optional",
		"--foreground-scripts",
	]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

export async function npmGlobalRoot(): Promise<string | null> {
	const r = await execAsync("npm", ["root", "-g"]);
	if (r.error) return null;
	const root = r.stdout.trim();
	return root || null;
}

export async function verifyInstall(tool: Tool): Promise<string | null> {
	const r = await execAsync(CLI[tool], ["--version"]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

export async function runClaudePostinstall(): Promise<string | null> {
	const root = await npmGlobalRoot();
	if (!root) return "could not resolve npm root -g";
	const script = join(root, "@anthropic-ai", "claude-code", "install.cjs");
	if (!existsSync(script)) return `${script} does not exist`;
	const r = await execAsync("node", [script]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

export async function installAndVerify(tool: Tool): Promise<string | null> {
	const installErr = await installPackage(PKG[tool]);
	if (installErr) return installErr;

	const firstVerify = await verifyInstall(tool);
	if (!firstVerify) return null;

	// Claude Code's package downloads its native binary in a postinstall.
	// If verification fails, the most common cause is that the postinstall
	// was suppressed (e.g. a global --ignore-scripts). Re-run install.cjs
	// directly — it only writes inside the package's own install directory.
	if (tool === "claude-code") {
		const postErr = await runClaudePostinstall();
		if (!postErr) {
			const second = await verifyInstall(tool);
			if (!second) return null;
			return `installed but '${CLI[tool]}' still fails after postinstall: ${second}`;
		}
		return `installed but '${CLI[tool]}' fails (${firstVerify}); postinstall recovery failed: ${postErr}`;
	}

	return `installed but '${CLI[tool]}' fails: ${firstVerify}`;
}

export async function detectInstalledViaNpm(tool: Tool): Promise<boolean> {
	const root = await npmGlobalRoot();
	if (!root) return false;
	const pkgDir = join(root, ...PKG[tool].split("/"));
	return existsSync(pkgDir);
}
