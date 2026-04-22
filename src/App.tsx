import { execFile } from "node:child_process";
import { Box, Text, useApp } from "ink";
import { useCallback, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Configure, configureTitle } from "@/components/Configure.js";
import { Confirm, confirmTitle } from "@/components/Confirm.js";
import { Frame } from "@/components/Frame.js";
import { Login, loginTitle } from "@/components/Login.js";
import { Step } from "@/components/Step.js";
import { ToolSelect, toolSelectTitle } from "@/components/ToolSelect.js";
import type { Tool } from "@/setup.js";

type Phase =
	| "select"
	| "confirm"
	| "installing"
	| "login"
	| "configuring"
	| "done";

export function App() {
	const { exit } = useApp();
	const [step, setStep] = useState<Phase>("select");
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
			<Frame tag="CoDev">
				<Step
					active={step === "select"}
					title={toolSelectTitle(step !== "select")}
				>
					<ToolSelect onConfirm={handleConfirm} readOnly={step !== "select"} />
				</Step>
				{step !== "select" && (
					<Step active={step === "confirm"} title={confirmTitle()}>
						<Confirm
							tools={tools}
							onConfirm={handleConfirmProceed}
							readOnly={step !== "confirm"}
						/>
					</Step>
				)}
				{(step === "installing" ||
					step === "login" ||
					step === "configuring") && (
					<Step
						active={step === "installing"}
						title={<Text bold>Installing packages</Text>}
					>
						<Box flexDirection="column">
							{logs.map((log, i) => (
								<Text key={`log-${i.toString()}`}>{log}</Text>
							))}
						</Box>
					</Step>
				)}
				{(step === "login" || step === "configuring") && (
					<Step active={step === "login"} title={loginTitle()}>
						<Login onDone={handleLoginDone} />
					</Step>
				)}
				{step === "configuring" && apiKey && (
					<Step active={step === "configuring"} title={configureTitle()}>
						<Configure
							tools={tools}
							apiKey={apiKey}
							onDone={handleConfigureDone}
						/>
					</Step>
				)}
			</Frame>
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
