import { execFile } from "node:child_process";
import { Box, Text, useApp } from "ink";
import { useCallback, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Configure } from "@/components/Configure.js";
import { Confirm } from "@/components/Confirm.js";
import { Login } from "@/components/Login.js";
import { ToolSelect } from "@/components/ToolSelect.js";
import type { Tool } from "@/setup.js";

type Step =
	| "select"
	| "confirm"
	| "installing"
	| "login"
	| "configuring"
	| "done";

export function App() {
	const { exit } = useApp();
	const [step, setStep] = useState<Step>("select");
	const [logs, setLogs] = useState<string[]>([]);
	const [tools, setTools] = useState<Tool[]>([]);
	const [apiKey, setApiKey] = useState<string | null>(null);

	const addLog = useCallback((msg: string) => {
		setLogs((prev) => [...prev, msg]);
	}, []);

	const handleConfirm = (selected: Tool[]) => {
		setTools(selected);
		setStep("confirm");
	};

	const handleConfirmProceed = useCallback(
		(proceed: boolean) => {
			if (!proceed) {
				exit();
				return;
			}
			setStep("installing");
			runInstall(tools, addLog).then(() => {
				setStep("login");
			});
		},
		[exit, tools, addLog],
	);

	const handleLoginDone = useCallback((key: string) => {
		setApiKey(key);
		setStep("configuring");
	}, []);

	const handleConfigureDone = useCallback(() => {
		setStep("done");
		exit();
	}, [exit]);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<ToolSelect onConfirm={handleConfirm} readOnly={step !== "select"} />
			{step === "confirm" && (
				<Confirm tools={tools} onConfirm={handleConfirmProceed} />
			)}
			{step !== "select" && step !== "confirm" && (
				<Box flexDirection="column" marginTop={1}>
					{logs.map((log, i) => (
						<Text key={`log-${i.toString()}`}>{log}</Text>
					))}
				</Box>
			)}
			{(step === "login" || step === "configuring") && (
				<Login onDone={handleLoginDone} />
			)}
			{step === "configuring" && apiKey && (
				<Configure tools={tools} apiKey={apiKey} onDone={handleConfigureDone} />
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

	log("Done!");
}
