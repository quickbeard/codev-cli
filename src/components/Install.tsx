import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import type { Tool } from "@/configure.js";

const PKG: Record<Tool, string> = {
	"claude-code": "@anthropic-ai/claude-code",
	opencode: "opencode-ai",
};

const CLI: Record<Tool, string> = {
	"claude-code": "claude",
	opencode: "opencode",
};

type Status = "pending" | "installing" | "done" | "failed";

interface Item {
	tool: Tool;
	pkg: string;
	status: Status;
	error?: string;
}

interface InstallProps {
	tools: Tool[];
	onDone: () => void;
}

interface ExecResult {
	stdout: string;
	stderr: string;
	error: NodeJS.ErrnoException | null;
}

function execAsync(file: string, args: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(file, args, (error, stdout, stderr) => {
			resolve({
				stdout: stdout?.toString() ?? "",
				stderr: stderr?.toString() ?? "",
				error: error as NodeJS.ErrnoException | null,
			});
		});
	});
}

async function installPackage(pkg: string): Promise<string | null> {
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

async function npmGlobalRoot(): Promise<string | null> {
	const r = await execAsync("npm", ["root", "-g"]);
	if (r.error) return null;
	const root = r.stdout.trim();
	return root || null;
}

async function verifyInstall(tool: Tool): Promise<string | null> {
	const r = await execAsync(CLI[tool], ["--version"]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

async function runClaudePostinstall(): Promise<string | null> {
	const root = await npmGlobalRoot();
	if (!root) return "could not resolve npm root -g";
	const script = join(root, "@anthropic-ai", "claude-code", "install.cjs");
	if (!existsSync(script)) return `${script} does not exist`;
	const r = await execAsync("node", [script]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

async function installAndVerify(tool: Tool): Promise<string | null> {
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

export function Install({ tools, onDone }: InstallProps) {
	const [items, setItems] = useState<Item[]>(() =>
		tools.map((tool) => ({ tool, pkg: PKG[tool], status: "pending" })),
	);
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		setItems((prev) => prev.map((it) => ({ ...it, status: "installing" })));
		(async () => {
			await Promise.all(
				tools.map(async (tool, i) => {
					const err = await installAndVerify(tool);
					setItems((prev) =>
						prev.map((it, idx) =>
							idx === i
								? {
										...it,
										status: err ? "failed" : "done",
										error: err ?? undefined,
									}
								: it,
						),
					);
				}),
			);
			onDone();
		})();
	}, [tools, onDone]);

	return (
		<Box flexDirection="column">
			{items.map((item) => (
				<InstallRow key={item.pkg} item={item} />
			))}
		</Box>
	);
}

function InstallRow({ item }: { item: Item }) {
	return (
		<Box>
			<Box marginRight={1}>
				<StatusIcon status={item.status} />
			</Box>
			<Text>{rowText(item)}</Text>
		</Box>
	);
}

function rowText(item: Item): string {
	switch (item.status) {
		case "installing":
			return `Installing ${item.pkg}...`;
		case "done":
			return `Installed ${item.pkg}`;
		case "failed":
			return `Failed to install ${item.pkg}: ${item.error ?? "unknown error"}`;
		default:
			return item.pkg;
	}
}

function StatusIcon({ status }: { status: Status }) {
	if (status === "installing") {
		return (
			<Text color="cyan">
				<Spinner />
			</Text>
		);
	}
	if (status === "done") return <Text color="green">✓</Text>;
	if (status === "failed") return <Text color="red">✗</Text>;
	return <Text dimColor>○</Text>;
}
