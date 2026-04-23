import { Box, Text, useApp } from "ink";
import { useCallback, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Configure, configureTitle } from "@/components/Configure.js";
import { Confirm, confirmTitle } from "@/components/Confirm.js";
import { Frame } from "@/components/Frame.js";
import { Install } from "@/components/Install.js";
import { Login, loginTitle } from "@/components/Login.js";
import { Step } from "@/components/Step.js";
import { ToolSelect, toolSelectTitle } from "@/components/ToolSelect.js";
import type { Tool } from "@/configure.js";

type Phase =
	| "select"
	| "confirm"
	| "installing"
	| "install-failed"
	| "login"
	| "login-failed"
	| "configuring"
	| "configure-failed"
	| "done";

const POST_INSTALL: Phase[] = [
	"login",
	"login-failed",
	"configuring",
	"configure-failed",
	"done",
];
const POST_LOGIN: Phase[] = ["configuring", "configure-failed", "done"];

export function App() {
	const { exit } = useApp();
	const [step, setStep] = useState<Phase>("select");
	const [tools, setTools] = useState<Tool[]>([]);
	const [apiKey, setApiKey] = useState<string | null>(null);

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
		},
		[exit],
	);

	// On failure we set a terminal `*-failed` phase and stop advancing. The
	// step's error frame stays rendered so the user can read it; exiting the
	// app is left to the user (Ctrl-C), matching Login/Configure's prior
	// hang-on-error behavior.
	const handleInstallDone = useCallback((success: boolean) => {
		setStep(success ? "login" : "install-failed");
	}, []);

	const handleLoginDone = useCallback((key: string | null) => {
		if (key === null) {
			setStep("login-failed");
			return;
		}
		setApiKey(key);
		setStep("configuring");
	}, []);

	const handleConfigureDone = useCallback(
		(success: boolean) => {
			if (!success) {
				setStep("configure-failed");
				return;
			}
			setStep("done");
			exit();
		},
		[exit],
	);

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
				{step !== "select" && step !== "confirm" && (
					<Step
						active={step === "installing"}
						title={<Text bold>Installing packages</Text>}
					>
						<Install tools={tools} onDone={handleInstallDone} />
					</Step>
				)}
				{POST_INSTALL.includes(step) && (
					<Step active={step === "login"} title={loginTitle()}>
						<Login onDone={handleLoginDone} />
					</Step>
				)}
				{POST_LOGIN.includes(step) && apiKey && (
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
