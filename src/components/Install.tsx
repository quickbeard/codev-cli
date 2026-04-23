import { execFile } from "node:child_process";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import type { Tool } from "@/configure.js";

const PKG: Record<Tool, string> = {
	"claude-code": "@anthropic-ai/claude-code",
	opencode: "opencode-ai",
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

function installPackage(pkg: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("npm", ["install", "-g", pkg], (error, _stdout, stderr) => {
			resolve(error ? stderr.trim() || error.message : null);
		});
	});
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
					const err = await installPackage(PKG[tool]);
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
