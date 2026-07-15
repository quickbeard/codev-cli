import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import {
	ReadinessAgentSelect,
	readinessAgentSelectTitle,
} from "@/components/ReadinessAgentSelect.js";
import { Step } from "@/components/Step.js";
import {
	type ReadinessOptions,
	type ReadinessRunResult,
	runReadiness,
} from "@/lib/readiness.js";
import {
	isAgentAvailable,
	READINESS_AGENTS,
	type ReadinessAgent,
} from "@/lib/readiness-agent.js";

type Phase = "select" | "running" | "done" | "failed";

interface ReadinessAppProps {
	available?: Record<ReadinessAgent, boolean>;
	run?: typeof runReadiness;
	options?: ReadinessOptions;
}

export function ReadinessApp({
	available,
	run = runReadiness,
	options = {},
}: ReadinessAppProps) {
	const { exit } = useApp();
	const detected = useMemo(
		() =>
			available ??
			(Object.fromEntries(
				READINESS_AGENTS.map((agent) => [agent, isAgentAvailable(agent)]),
			) as Record<ReadinessAgent, boolean>),
		[available],
	);
	const [phase, setPhase] = useState<Phase>("select");
	const [agent, setAgent] = useState<ReadinessAgent | null>(null);
	const [progress, setProgress] = useState("Preparing readiness scan");
	const [result, setResult] = useState<ReadinessRunResult | null>(null);
	const hasAvailableAgent = READINESS_AGENTS.some(
		(candidate) => detected[candidate],
	);

	const selectAgent = useCallback(
		(choice: ReadinessAgent) => {
			setAgent(choice);
			setPhase("running");
			run(choice, setProgress, options)
				.then((next) => {
					setResult(next);
					setPhase(next.exitCode === 0 ? "done" : "failed");
				})
				.catch((error) => {
					setResult({
						exitCode: 1,
						message: error instanceof Error ? error.message : String(error),
					});
					setPhase("failed");
				});
		},
		[run, options],
	);

	useEffect(() => {
		if (phase !== "done") return;
		const timer = setTimeout(() => exit(), 50);
		return () => clearTimeout(timer);
	}, [phase, exit]);

	return (
		<Box flexDirection="column">
			<Banner />
			<Frame tag="AGENT READINESS">
				{!hasAvailableAgent && (
					<Text color="red">
						No supported coding agent is available. Run `codev install` first.
					</Text>
				)}
				<Step
					active={phase === "select"}
					title={readinessAgentSelectTitle(phase !== "select")}
				>
					<ReadinessAgentSelect
						available={detected}
						selected={agent}
						readOnly={phase !== "select" || !hasAvailableAgent}
						onSelect={selectAgent}
					/>
				</Step>
				{phase !== "select" && (
					<Step
						active={phase === "running"}
						title={<Text bold>Evaluate repository</Text>}
					>
						{phase === "running" ? (
							<Box>
								<Text color="cyan">
									<Spinner />
								</Text>
								<Text>{` ${progress}...`}</Text>
							</Box>
						) : (
							<Text color={phase === "done" ? "green" : "red"}>
								{phase === "done" ? "✓ " : "✗ "}
								{result?.message}
							</Text>
						)}
					</Step>
				)}
				{phase === "failed" && (
					<Text dimColor>Fix the issue above and rerun `codev readiness`.</Text>
				)}
			</Frame>
		</Box>
	);
}
