import { Box, Text, useApp } from "ink";
import { useCallback, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import { Update } from "@/components/Update.js";
import { HAPPY_CODING, HELP_HINT } from "@/const.js";

type Phase = "running" | "success" | "fail";

export function UpdateApp() {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("running");

	const handleDone = useCallback(
		(success: boolean) => {
			if (!success) {
				setPhase("fail");
				exit(new Error("update failed"));
				return;
			}
			setPhase("success");
			setTimeout(() => exit(), 1000);
		},
		[exit],
	);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="CoDev">
				<Step active title={<Text bold>Updating packages</Text>}>
					<Update onDone={handleDone} />
					{phase === "success" && (
						<Box marginTop={1} flexDirection="column">
							<Text dimColor>{HELP_HINT}</Text>
							<Text bold color="magenta">
								{HAPPY_CODING}
							</Text>
						</Box>
					)}
				</Step>
			</Frame>
		</Box>
	);
}
