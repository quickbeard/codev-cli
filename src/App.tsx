import { execFile } from "node:child_process";
import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import { setupClaude, type Tool } from "./setup.js";

const VERSION = "0.1.0";

const BANNER = [
	" ██████╗ ██████╗ ██████╗ ███████╗██╗   ██╗",
	"██╔════╝██╔═══██╗██╔══██╗██╔════╝██║   ██║",
	"██║     ██║   ██║██║  ██║█████╗  ██║   ██║",
	"██║     ██║   ██║██║  ██║██╔══╝  ╚██╗ ██╔╝",
	"╚██████╗╚██████╔╝██████╔╝███████╗ ╚████╔╝ ",
	" ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝  ╚═══╝  ",
].join("\n");

type Step = "select" | "installing" | "done";

const TOOLS: { label: string; icon: string; value: Tool }[] = [
	{ label: "Claude Code", icon: "🤖", value: "claude-code" },
	{ label: "OpenCode", icon: "💻", value: "opencode" },
];

export function App() {
	const { exit } = useApp();
	const [step, setStep] = useState<Step>("select");
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState<Set<Tool>>(new Set());
	const [logs, setLogs] = useState<string[]>([]);

	const addLog = (msg: string) => {
		setLogs((prev) => [...prev, msg]);
	};

	useInput((input, key) => {
		if (step !== "select") return;

		if (key.upArrow) {
			setCursor((c) => Math.max(0, c - 1));
		} else if (key.downArrow) {
			setCursor((c) => Math.min(TOOLS.length - 1, c + 1));
		} else if (input === " ") {
			setSelected((prev) => {
				const next = new Set(prev);
				const tool = TOOLS[cursor];
				if (!tool) return next;
				if (next.has(tool.value)) {
					next.delete(tool.value);
				} else {
					next.add(tool.value);
				}
				return next;
			});
		} else if (key.return) {
			if (selected.size === 0) return;
			setStep("installing");
			runInstall([...selected], addLog).then(() => {
				setStep("done");
				exit();
			});
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box alignItems="center" justifyContent="center" flexDirection="column">
				<Text bold color="cyan">
					{BANNER}
				</Text>
				<Box marginTop={1} justifyContent="center">
					<Text>{"⚡ Coding Agent Installer  "}</Text>
					<Text dimColor>v{VERSION}</Text>
				</Box>
			</Box>
			<Box justifyContent="center">
				<Text dimColor>{"─".repeat(45)}</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				<Text bold>
					{"📋 "}
					<Text color="yellow">Step 1/2</Text>
					{" — Select Tool to Install"}
				</Text>
				<Text dimColor>
					{"\n"}Choose which coding agent(s) to install and configure.
				</Text>
				<Text dimColor>
					{"\n"}Use ↑/↓ to navigate, Space to select, Enter to confirm
				</Text>
				<Box flexDirection="column" marginTop={1}>
					{step === "select" &&
						TOOLS.map((tool, i) => {
							const isSelected = selected.has(tool.value);
							const isCursor = cursor === i;
							const pointer = isCursor ? "❯" : " ";
							return (
								<Box key={tool.value}>
									<Text bold color={isCursor ? "yellow" : undefined}>
										{pointer}{" "}
									</Text>
									<Text>{tool.icon} </Text>
									<Text
										color={
											isCursor ? "yellow" : isSelected ? "green" : undefined
										}
										bold={isCursor}
									>
										{tool.label}
									</Text>
									{isSelected && <Text color="green"> ✔</Text>}
								</Box>
							);
						})}
				</Box>
			</Box>
			{step !== "select" && (
				<Box flexDirection="column" marginTop={1}>
					{logs.map((log, i) => (
						<Text key={`log-${i.toString()}`}>{log}</Text>
					))}
				</Box>
			)}
		</Box>
	);
}

async function runInstall(tools: Tool[], log: (msg: string) => void) {
	for (const tool of tools) {
		const pkg =
			tool === "claude-code" ? "@anthropic-ai/claude-code" : "opencode-ai";
		log(`Installing ${pkg}...`);
		await new Promise<void>((resolve) => {
			execFile("npm", ["install", "-g", pkg], (error, _stdout, stderr) => {
				if (error) {
					log(`Failed to install ${pkg}: ${stderr.trim()}`);
				} else {
					log(`Installed ${pkg}`);
				}
				resolve();
			});
		});
	}

	log("Configuring .claude.json...");
	await setupClaude();
	log("Done!");
}
