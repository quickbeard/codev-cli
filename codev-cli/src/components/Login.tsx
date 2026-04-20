import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { login } from "@/auth.js";
import { fetchApiKey } from "@/backend.js";

interface LoginProps {
	onDone: () => void;
}

export function Login({ onDone }: LoginProps) {
	const [logs, setLogs] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [apiKey, setApiKey] = useState<string | null>(null);
	const [waitingForEnter, setWaitingForEnter] = useState(false);
	const openBrowserRef = useRef<(() => void) | null>(null);

	const addLog = useCallback((msg: string) => {
		setLogs((prev) => [...prev, msg]);
	}, []);

	useEffect(() => {
		login(addLog, (openBrowserFn) => {
			openBrowserRef.current = openBrowserFn;
			setWaitingForEnter(true);
		})
			.then(async (auth) => {
				addLog("Fetching API key from backend...");
				const key = await fetchApiKey(auth.access_token);
				setApiKey(key);
				addLog("API key ready.");
				setTimeout(onDone, 1000);
			})
			.catch((err: Error) => setError(err.message));
	}, [addLog, onDone]);

	useInput((_input, key) => {
		if (waitingForEnter && key.return && openBrowserRef.current) {
			setWaitingForEnter(false);
			openBrowserRef.current();
			openBrowserRef.current = null;
		}
	});

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text bold>
				{"🔐 "}
				<Text color="yellow">Step 2/2</Text>
				{" — Login to Viettel SSO:"}
			</Text>
			{logs.map((log, i) => (
				<Text key={`login-${i.toString()}`}>{`  ${log}`}</Text>
			))}
			{waitingForEnter && (
				<Text color="cyan">
					{"  Press Enter to open the browser and login..."}
				</Text>
			)}
			{apiKey && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold color="green">
						{"  ✅ Your API key:"}
					</Text>
					<Text color="cyan">{`     ${apiKey}`}</Text>
					<Box marginTop={1}>
						<Text bold color="magenta">
							{"  🎉 Happy coding!"}
						</Text>
					</Box>
				</Box>
			)}
			{error && <Text color="red">{`  Login failed: ${error}`}</Text>}
		</Box>
	);
}
