import { execFile } from "node:child_process";
import { Box, Text, useApp } from "ink";
import { useCallback, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Login } from "@/components/Login.js";
import { ToolSelect } from "@/components/ToolSelect.js";
import { setupClaude, type Tool } from "@/setup.js";

type Step = "select" | "installing" | "login" | "done";

export function App() {
	const { exit } = useApp();
	const [step, setStep] = useState<Step>("select");
	const [logs, setLogs] = useState<string[]>([]);

	const addLog = (msg: string) => {
		setLogs((prev) => [...prev, msg]);
	};

	const handleConfirm = (tools: Tool[]) => {
		setStep("installing");
		runInstall(tools, addLog).then(() => {
			setStep("login");
		});
	};

	const handleLoginDone = useCallback(() => {
		setStep("done");
		exit();
	}, [exit]);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			{step === "select" && <ToolSelect onConfirm={handleConfirm} />}
			{step !== "select" && (
				<Box flexDirection="column" marginTop={1}>
					{logs.map((log, i) => (
						<Text key={`log-${i.toString()}`}>{log}</Text>
					))}
				</Box>
			)}
			{step === "login" && <Login onDone={handleLoginDone} />}
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
