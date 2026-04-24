import { Box, Text, useApp } from "ink";
import { useCallback, useState } from "react";
import type { AuthMethodChoice } from "@/components/AuthMethod.js";
import { AuthMethod, authMethodTitle } from "@/components/AuthMethod.js";
import { Banner } from "@/components/Banner.js";
import { Configure, configureTitle } from "@/components/Configure.js";
import { Confirm, confirmTitle } from "@/components/Confirm.js";
import { Frame } from "@/components/Frame.js";
import { Install } from "@/components/Install.js";
import { Login, loginTitle } from "@/components/Login.js";
import {
	ManualCredentials,
	type ManualCredentialsValue,
	manualCredentialsTitle,
} from "@/components/ManualCredentials.js";
import { Step } from "@/components/Step.js";
import { ToolSelect, toolSelectTitle } from "@/components/ToolSelect.js";
import type { Credentials, Tool } from "@/configure.js";

type Phase =
	| "select"
	| "confirm"
	| "installing"
	| "install-failed"
	| "auth-method"
	| "login"
	| "manual-creds"
	| "configuring"
	| "configure-failed"
	| "done";

const POST_INSTALL: Phase[] = [
	"auth-method",
	"login",
	"manual-creds",
	"configuring",
	"configure-failed",
	"done",
];
const POST_AUTH_METHOD: Phase[] = [
	"login",
	"manual-creds",
	"configuring",
	"configure-failed",
	"done",
];
const POST_AUTH: Phase[] = ["configuring", "configure-failed", "done"];

export function App() {
	const { exit } = useApp();
	const [step, setStep] = useState<Phase>("select");
	const [tools, setTools] = useState<Tool[]>([]);
	const [authMethod, setAuthMethod] = useState<AuthMethodChoice | null>(null);
	const [creds, setCreds] = useState<Credentials | null>(null);

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
		setStep(success ? "auth-method" : "install-failed");
	}, []);

	const handleAuthMethod = useCallback((choice: AuthMethodChoice) => {
		setAuthMethod(choice);
		setStep(choice === "sso" ? "login" : "manual-creds");
	}, []);

	const handleLoginDone = useCallback((key: string) => {
		setCreds({ apiKey: key });
		setStep("configuring");
	}, []);

	const handleManualDone = useCallback((value: ManualCredentialsValue) => {
		setCreds({
			apiKey: value.apiKey,
			baseUrl: value.baseUrl,
			model: value.model,
		});
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
					<Step
						active={step === "auth-method"}
						title={authMethodTitle(step !== "auth-method")}
					>
						<AuthMethod
							onSelect={handleAuthMethod}
							readOnly={step !== "auth-method"}
							selected={authMethod}
						/>
					</Step>
				)}
				{POST_AUTH_METHOD.includes(step) && authMethod === "sso" && (
					<Step active={step === "login"} title={loginTitle()}>
						<Login onDone={handleLoginDone} />
					</Step>
				)}
				{POST_AUTH_METHOD.includes(step) && authMethod === "manual" && (
					<Step
						active={step === "manual-creds"}
						title={manualCredentialsTitle()}
					>
						<ManualCredentials
							onDone={handleManualDone}
							readOnly={step !== "manual-creds"}
						/>
					</Step>
				)}
				{POST_AUTH.includes(step) && creds && (
					<Step active={step === "configuring"} title={configureTitle()}>
						<Configure
							tools={tools}
							creds={creds}
							onDone={handleConfigureDone}
						/>
					</Step>
				)}
			</Frame>
		</Box>
	);
}
