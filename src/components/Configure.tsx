import { Box, Text } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	type BackupKind,
	type ConfigureResult,
	configureClaudeCode,
	configureOpenCode,
	type Tool,
} from "@/configure.js";

interface ConfigureProps {
	tools: Tool[];
	apiKey: string;
	onDone: () => void;
}

type Phase = "running" | "done" | "error";

const LABEL: Record<BackupKind, string> = {
	"claude-settings": "Claude Code",
	"opencode-config": "OpenCode",
};

const RUN_CMD: Record<Tool, string> = {
	"claude-code": "codev claude",
	opencode: "codev opencode",
};

function resumeMessage(tools: Tool[]): ReactNode {
	if (tools.length === 0) return null;
	const parts = tools.flatMap((t, i) => {
		const cmd = (
			<Text key={t} color="cyan">
				{RUN_CMD[t]}
			</Text>
		);
		if (i === 0) return [cmd];
		const sep = i === tools.length - 1 ? " or " : ", ";
		return [sep, cmd];
	});
	return (
		<Text>
			{"Done! You can now run "}
			{parts}
			{" to get started."}
		</Text>
	);
}

function describeResult(r: ConfigureResult): string[] {
	return [`Configured ${LABEL[r.kind]}`];
}

export function Configure({ tools, apiKey, onDone }: ConfigureProps) {
	const [phase, setPhase] = useState<Phase>("running");
	const [logs, setLogs] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const hasRun = useRef(false);

	useEffect(() => {
		if (phase !== "running" || hasRun.current) return;
		hasRun.current = true;
		try {
			const results: ConfigureResult[] = [];
			for (const tool of tools) {
				if (tool === "claude-code") {
					results.push(...configureClaudeCode(apiKey));
				} else if (tool === "opencode") {
					results.push(...configureOpenCode(apiKey));
				}
			}
			const next: string[] = [];
			for (const r of results) {
				next.push(...describeResult(r));
			}
			setLogs(next);
			setPhase("done");
			setTimeout(onDone, 1000);
		} catch (err) {
			setError((err as Error).message);
			setPhase("error");
		}
	}, [phase, tools, apiKey, onDone]);

	return (
		<Box flexDirection="column">
			{logs.map((log, i) => (
				<Text key={`cfg-${i.toString()}`}>{log}</Text>
			))}
			{phase === "done" && (
				<Box marginBottom={1} flexDirection="column">
					{resumeMessage(tools)}
					<Box marginTop={1}>
						<Text dimColor>{"Run `codev --help` to see all commands."}</Text>
					</Box>
					<Text bold color="magenta">
						{"🎉 Happy coding!"}
					</Text>
				</Box>
			)}
			{error && <Text color="red">{`Configure failed: ${error}`}</Text>}
		</Box>
	);
}

export function configureTitle() {
	return <Text bold>{"Configure tools"}</Text>;
}
