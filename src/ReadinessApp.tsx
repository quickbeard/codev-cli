import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import {
	ReadinessAgentSelect,
	readinessAgentSelectTitle,
} from "@/components/ReadinessAgentSelect.js";
import {
	ReadinessProfileSelect,
	readinessProfileSelectTitle,
} from "@/components/ReadinessProfileSelect.js";
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
import {
	fetchReadinessProfiles,
	type ReadinessProfile,
	type ReadinessProfileSession,
	selectReadinessProfile,
} from "@/lib/readiness-profile.js";

type Phase =
	| "loading-profiles"
	| "select-profile"
	| "select-agent"
	| "running"
	| "done"
	| "failed";
const EMPTY_READINESS_OPTIONS: ReadinessOptions = {};

interface ReadinessAppProps {
	available?: Record<ReadinessAgent, boolean>;
	run?: typeof runReadiness;
	options?: ReadinessOptions;
	profileSelector?: string;
	requestedAgent?: ReadinessAgent;
	loadProfiles?: typeof fetchReadinessProfiles;
}

export function ReadinessApp({
	available,
	run = runReadiness,
	options = EMPTY_READINESS_OPTIONS,
	profileSelector,
	requestedAgent,
	loadProfiles = fetchReadinessProfiles,
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
	const [phase, setPhase] = useState<Phase>("loading-profiles");
	const [agent, setAgent] = useState<ReadinessAgent | null>(null);
	const [progress, setProgress] = useState("Loading readiness profiles");
	const [result, setResult] = useState<ReadinessRunResult | null>(null);
	const [session, setSession] = useState<ReadinessProfileSession | null>(null);
	const [profile, setProfile] = useState<ReadinessProfile | null>(null);
	const profileFetchMs = useRef(0);
	const hasAvailableAgent = READINESS_AGENTS.some(
		(candidate) => detected[candidate],
	);

	const startRun = useCallback(
		(
			choice: ReadinessAgent,
			chosen: ReadinessProfile,
			loaded: ReadinessProfileSession,
		) => {
			if (!detected[choice]) {
				setResult({
					exitCode: 1,
					message: `${choice} is not available on PATH.`,
				});
				setPhase("failed");
				return;
			}
			setAgent(choice);
			setPhase("running");
			run(choice, setProgress, {
				...options,
				profile: chosen,
				auth: loaded.auth,
				profileFetchMs: profileFetchMs.current,
			})
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
		[detected, run, options],
	);
	const chooseProfile = useCallback(
		(chosen: ReadinessProfile, loaded = session) => {
			if (!loaded) return;
			setProfile(chosen);
			if (requestedAgent) startRun(requestedAgent, chosen, loaded);
			else setPhase("select-agent");
		},
		[requestedAgent, session, startRun],
	);
	const selectAgent = useCallback(
		(choice: ReadinessAgent) => {
			if (profile && session) startRun(choice, profile, session);
		},
		[profile, session, startRun],
	);

	useEffect(() => {
		let active = true;
		const started = Date.now();
		loadProfiles(setProgress)
			.then((loaded) => {
				if (!active) return;
				profileFetchMs.current = Date.now() - started;
				setSession(loaded);
				const chosen = selectReadinessProfile(loaded.profiles, profileSelector);
				if (chosen) {
					setProfile(chosen);
					if (requestedAgent) startRun(requestedAgent, chosen, loaded);
					else setPhase("select-agent");
				} else setPhase("select-profile");
			})
			.catch((error) => {
				if (!active) return;
				setResult({
					exitCode: 1,
					message: error instanceof Error ? error.message : String(error),
				});
				setPhase("failed");
			});
		return () => {
			active = false;
		};
	}, [loadProfiles, profileSelector, requestedAgent, startRun]);

	useEffect(() => {
		if (phase !== "done") return;
		const timer = setTimeout(() => exit(), 50);
		return () => clearTimeout(timer);
	}, [phase, exit]);

	return (
		<Box flexDirection="column">
			<Banner />
			<Frame tag="AGENT READINESS">
				{phase === "loading-profiles" && (
					<Box>
						<Text color="cyan">
							<Spinner />
						</Text>
						<Text>{` ${progress}...`}</Text>
					</Box>
				)}
				{phase !== "loading-profiles" && !hasAvailableAgent && (
					<Text color="red">
						No supported coding agent is available. Run `codev install` first.
					</Text>
				)}
				{session && profile === null && phase === "select-profile" && (
					<Step active title={readinessProfileSelectTitle(false)}>
						<ReadinessProfileSelect
							profiles={session.profiles}
							onSelect={chooseProfile}
						/>
					</Step>
				)}
				{profile && (
					<Step active={false} title={readinessProfileSelectTitle(true)}>
						<ReadinessProfileSelect
							profiles={[profile]}
							selected={profile}
							readOnly
							onSelect={() => {}}
						/>
					</Step>
				)}
				{phase !== "loading-profiles" && phase !== "select-profile" && (
					<Step
						active={phase === "select-agent"}
						title={readinessAgentSelectTitle(phase !== "select-agent")}
					>
						<ReadinessAgentSelect
							available={detected}
							selected={agent}
							readOnly={phase !== "select-agent" || !hasAvailableAgent}
							onSelect={selectAgent}
						/>
					</Step>
				)}
				{["running", "done", "failed"].includes(phase) && profile && (
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
