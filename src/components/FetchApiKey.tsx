import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";
import type { AuthData } from "@/lib/auth.js";
import { fetchApiKey, isKeyRefusal } from "@/lib/backend.js";
import { BACKEND_URL } from "@/lib/const.js";
import { describeFailure } from "@/lib/doctor.js";

interface FetchApiKeyProps {
	auth: AuthData;
	onDone: (apiKey: string) => void;
	onFallback: () => void;
}

// Persisting the key is the caller's responsibility — only the caller knows
// what shape the full credential tuple (apiKey + baseUrl + model) should take
// at this moment. A previous version called saveApiKey({apiKey}) here, which
// clobbered base_url/model on disk and forced every caller to immediately
// re-save with the preserved fields.
export function FetchApiKey({ auth, onDone, onFallback }: FetchApiKeyProps) {
	const [pending, setPending] = useState(true);
	const [error, setError] = useState<string | null>(null);
	// The gateway declined this user outright (backend `key_refused`). Held
	// apart from `error` because it gets no retry affordance: the answer will
	// not change, and "Press Enter to retry" under it sent users looping on a
	// failure only the gateway team can fix.
	const [refused, setRefused] = useState<string | null>(null);
	const [emptyCount, setEmptyCount] = useState(0);
	const [succeeded, setSucceeded] = useState(false);
	// Set once this component has handed the flow to the manual-credentials
	// step. Together with `succeeded` it switches the key listener off: the
	// parent keeps this Step mounted as read-only history, and a listener left
	// live here would keep answering every later Enter (model pick, smoke-test
	// spinner) by calling onFallback again and yanking the wizard backwards.
	const [handedOff, setHandedOff] = useState(false);
	const [attempt, setAttempt] = useState(0);

	// `attempt` is the retry trigger — bumping it re-runs the effect.
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry trigger
	useEffect(() => {
		setError(null);
		setPending(true);

		fetchApiKey(auth.access_token)
			.then((key) => {
				setPending(false);
				if (!key) {
					setEmptyCount((n) => n + 1);
					return;
				}
				setSucceeded(true);
				onDone(key);
			})
			.catch((err: Error) => {
				setPending(false);
				if (isKeyRefusal(err)) {
					// The backend's `reason` is the gateway's own sentence (which
					// domains it accepts); the surrounding "Backend … failed (403)"
					// wrapper is noise to the person reading it.
					setRefused(err.reason);
					return;
				}
				// A transport failure here (proxy/TLS/DNS) gets the full diagnosis;
				// a backend HTTP error keeps its own already-precise message.
				setError(
					describeFailure(err, {
						url: `${BACKEND_URL}/auth/exchange`,
						method: "POST",
					}),
				);
			});
	}, [auth.access_token, onDone, attempt]);

	const fallBack = () => {
		setHandedOff(true);
		onFallback();
	};

	useInput(
		(_input, key) => {
			if (pending) return;
			if (!key.return) return;
			if (refused) {
				fallBack();
				return;
			}
			if (error) {
				setAttempt((n) => n + 1);
				return;
			}
			if (emptyCount === 1) {
				setAttempt((n) => n + 1);
				return;
			}
			if (emptyCount >= 2) {
				fallBack();
			}
		},
		{ isActive: !succeeded && !handedOff },
	);

	return (
		<Box flexDirection="column">
			{pending && (
				<Box>
					<Text color="cyan">
						<Spinner />
					</Text>
					<Text> Fetching API key from gateway...</Text>
				</Box>
			)}
			{succeeded && (
				<Text color="green">{"✓ API key obtained successfully."}</Text>
			)}
			{refused && (
				<>
					<Text color="red">{`✗ ${refused}`}</Text>
					<Text dimColor>
						{
							"Retrying won't change this — ask the gateway team to enable your account, or use an API key issued to you by hand."
						}
					</Text>
					{!handedOff && (
						<Text dimColor>
							{"Press Enter to enter your own API key, Ctrl-C to quit"}
						</Text>
					)}
				</>
			)}
			{error && (
				<>
					{/* One-line reasons stay inline; a multi-line transport
					    diagnosis keeps its structure on following lines. */}
					<Text color="red">{`Failed to fetch API key: ${error.split("\n")[0] ?? ""}`}</Text>
					{error
						.split("\n")
						.slice(1)
						.map((line, i) => (
							<Text key={`key-err-${i.toString()}`} color="red">
								{line}
							</Text>
						))}
					<Text dimColor>{"Press Enter to retry, Ctrl-C to quit"}</Text>
				</>
			)}
			{!pending && !error && emptyCount === 1 && (
				<>
					<Text color="yellow">{"Gateway returned an empty API key."}</Text>
					<Text dimColor>{"Press Enter to retry, Ctrl-C to quit"}</Text>
				</>
			)}
			{!pending && !error && emptyCount >= 2 && (
				<>
					<Text color="yellow">
						{"Gateway returned an empty API key again."}
					</Text>
					{!handedOff && (
						<Text dimColor>
							{"Press Enter to enter credentials manually, Ctrl-C to quit"}
						</Text>
					)}
				</>
			)}
		</Box>
	);
}

export function fetchApiKeyTitle() {
	return <Text bold>{"Fetching new API Key"}</Text>;
}
