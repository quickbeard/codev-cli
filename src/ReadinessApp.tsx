import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { PasteBackPrompt, usePasteBack } from "@/components/PasteBack.js";
import {
	ReadinessAgentSelect,
	readinessAgentSelectTitle,
} from "@/components/ReadinessAgentSelect.js";
import {
	ReadinessProfileSelect,
	readinessProfileSelectTitle,
} from "@/components/ReadinessProfileSelect.js";
import { Step } from "@/components/Step.js";
import { useCanType } from "@/components/useCanType.js";
import {
	type ReadinessOptions,
	type ReadinessRunResult,
	runReadiness,
} from "@/lib/readiness.js";
import {
	isReadinessAgentAvailable,
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
				READINESS_AGENTS.map((agent) => [
					agent,
					isReadinessAgentAvailable(agent),
				]),
			) as Record<ReadinessAgent, boolean>),
		[available],
	);
	const [phase, setPhase] = useState<Phase>("loading-profiles");
	const [agent, setAgent] = useState<ReadinessAgent | null>(null);
	const [progress, setProgress] = useState("Loading readiness profiles");
	const [loginUrl, setLoginUrl] = useState<string | null>(null);
	const [result, setResult] = useState<ReadinessRunResult | null>(null);
	const [session, setSession] = useState<ReadinessProfileSession | null>(null);
	const [profile, setProfile] = useState<ReadinessProfile | null>(null);
	const profileFetchMs = useRef(0);
	const canType = useCanType();
	// Keep stdin referenced across the async SSO-to-selector transition. Without
	// continuous input ownership, Ink can emit `beforeExit` after the callback
	// server closes and unmount just as the agent selector becomes interactive.
	useInput(() => undefined, {
		isActive: canType && phase !== "done" && phase !== "failed",
	});
	const paste = usePasteBack(
		loginUrl !== null && phase !== "failed" && phase !== "done",
	);
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
			setLoginUrl(null);
			setPhase("running");
			run(choice, setProgress, {
				...options,
				profile: chosen,
				auth: loaded.auth,
				profileFetchMs: profileFetchMs.current,
				onLoginUrl: setLoginUrl,
				onManualSubmit: (submit) => {
					paste.submitRef.current = submit;
				},
				onLoginDone: () => setLoginUrl(null),
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
		[detected, run, options, paste.submitRef],
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
		loadProfiles(setProgress, {
			onLoginUrl: setLoginUrl,
			onManualSubmit: (submit) => {
				paste.submitRef.current = submit;
			},
		})
			.then((loaded) => {
				if (!active) return;
				profileFetchMs.current = Date.now() - started;
				setLoginUrl(null);
				setSession(loaded);
				const chosen =
					profileSelector || loaded.profiles.length === 1
						? selectReadinessProfile(loaded.profiles, profileSelector)
						: undefined;
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
	}, [
		loadProfiles,
		profileSelector,
		requestedAgent,
		startRun,
		paste.submitRef,
	]);

	useEffect(() => {
		if (phase !== "done" && phase !== "failed") return;
		const timer = setTimeout(() => {
			if (phase === "failed")
				exit(new Error(result?.message ?? "Readiness failed."));
			else exit();
		}, 50);
		return () => clearTimeout(timer);
	}, [phase, result, exit]);

	return (
		<Box flexDirection="column">
			<Banner />
			<Frame tag="AGENT READINESS">
				{phase === "loading-profiles" && (
					<Box flexDirection="column">
						<Box>
							<Text color="cyan">
								<Spinner />
							</Text>
							<Text>{` ${progress}...`}</Text>
						</Box>
						{loginUrl && !paste.submitting && (
							<Box flexDirection="column" marginTop={1}>
								<Text dimColor>
									{"If the browser didn't open, visit this URL manually:"}
								</Text>
								<Text>{loginUrl}</Text>
								<PasteBackPrompt
									pasteValue={paste.pasteValue}
									pasteError={paste.pasteError}
									submitting={paste.submitting}
								/>
							</Box>
						)}
					</Box>
				)}
				{phase !== "loading-profiles" && !hasAvailableAgent && (
					<Text color="red">
						No supported coding agent is available. Run `codevhub install`
						first.
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
				{profile &&
					phase !== "loading-profiles" &&
					phase !== "select-profile" && (
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
							<Box flexDirection="column">
								<Box>
									<Text color="cyan">
										<Spinner />
									</Text>
									<Text>{` ${progress}...`}</Text>
								</Box>
								{loginUrl && !paste.submitting && (
									<Box flexDirection="column" marginTop={1}>
										<Text dimColor>
											{"If the browser didn't open, visit this URL manually:"}
										</Text>
										<Text>{loginUrl}</Text>
										<PasteBackPrompt
											pasteValue={paste.pasteValue}
											pasteError={paste.pasteError}
											submitting={paste.submitting}
										/>
									</Box>
								)}
							</Box>
						) : phase === "done" ? (
							<Text color={phase === "done" ? "green" : "red"}>
								✓ {result?.message}
							</Text>
						) : null}
					</Step>
				)}
				{phase === "failed" && (
					<Box flexDirection="column">
						<Text color="red">✗ {result?.message ?? "Readiness failed."}</Text>
						<Text dimColor>
							Fix the issue above and rerun `codevhub readiness`.
						</Text>
					</Box>
				)}
			</Frame>
		</Box>
	);
}
