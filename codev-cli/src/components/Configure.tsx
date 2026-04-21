import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { configureClaudeCode, configureOpenCode, type Tool } from "@/setup.js";

interface ConfigureProps {
	tools: Tool[];
	apiKey: string;
	onDone: () => void;
}

export function Configure({ tools, apiKey, onDone }: ConfigureProps) {
	const [logs, setLogs] = useState<string[]>([]);
	const [done, setDone] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const next: string[] = [];
		try {
			for (const tool of tools) {
				if (tool === "claude-code") {
					configureClaudeCode(apiKey);
					next.push("Configured Claude Code (~/.claude/settings.json)");
				} else if (tool === "opencode") {
					configureOpenCode(apiKey);
					next.push("Configured OpenCode (~/.config/opencode/opencode.json)");
				}
			}
			setLogs(next);
			setDone(true);
			setTimeout(onDone, 1000);
		} catch (err) {
			setError((err as Error).message);
		}
	}, [tools, apiKey, onDone]);

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text bold>
				{"⚙️  "}
				<Text color="yellow">Step 3/3</Text>
				{" — Configure tools:"}
			</Text>
			{logs.map((log, i) => (
				<Text key={`cfg-${i.toString()}`}>{`  ${log}`}</Text>
			))}
			{done && (
				<Box marginTop={1}>
					<Text bold color="magenta">
						{"  🎉 Happy coding!"}
					</Text>
				</Box>
			)}
			{error && <Text color="red">{`  Configure failed: ${error}`}</Text>}
		</Box>
	);
}
