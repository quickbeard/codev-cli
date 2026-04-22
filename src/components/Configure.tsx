import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import {
	type BackupKind,
	type ConfigureResult,
	configureClaudeCode,
	configureOpenCode,
	getBackupStatus,
	type Tool,
} from "@/setup.js";

interface ConfigureProps {
	tools: Tool[];
	apiKey: string;
	onDone: () => void;
}

type Phase = "prompt" | "running" | "done" | "error";

interface Conflict {
	kind: BackupKind;
	backupPath: string;
}

const LABEL: Record<BackupKind, string> = {
	"claude-dir": "Claude Code",
	"opencode-dir": "OpenCode",
};

const RESTORE_CMD: Record<BackupKind, string> = {
	"claude-dir": "codev claude --restore",
	"opencode-dir": "codev opencode --restore",
};

function scanConflicts(tools: Tool[]): Conflict[] {
	const out: Conflict[] = [];
	for (const tool of tools) {
		for (const s of getBackupStatus(tool)) {
			if (s.hasSource && s.hasBackup) {
				out.push({ kind: s.kind, backupPath: s.backupPath });
			}
		}
	}
	return out;
}

function describeResult(r: ConfigureResult): string[] {
	const lines = [`Configured ${LABEL[r.kind]}`];
	if (r.backupPath) {
		lines.push(`  Backup: ${r.backupPath}`);
		lines.push(`  Restore: ${RESTORE_CMD[r.kind]}`);
	}
	return lines;
}

export function Configure({ tools, apiKey, onDone }: ConfigureProps) {
	const [conflicts] = useState(() => scanConflicts(tools));
	const [phase, setPhase] = useState<Phase>(
		conflicts.length > 0 ? "prompt" : "running",
	);
	const [index, setIndex] = useState(0);
	const [overwrites, setOverwrites] = useState<Set<BackupKind>>(new Set());
	const [logs, setLogs] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const hasRun = useRef(false);

	const current = conflicts[index];

	useInput(
		(input, key) => {
			if (!current) return;
			const answer = input.toLowerCase();
			let keep = false;
			if (answer === "y") {
				keep = false;
			} else if (answer === "n" || key.return) {
				keep = true;
			} else {
				return;
			}
			if (!keep) {
				setOverwrites((prev) => {
					const next = new Set(prev);
					next.add(current.kind);
					return next;
				});
			}
			const nextIdx = index + 1;
			if (nextIdx >= conflicts.length) {
				setPhase("running");
			} else {
				setIndex(nextIdx);
			}
		},
		{ isActive: phase === "prompt" },
	);

	useEffect(() => {
		if (phase !== "running" || hasRun.current) return;
		hasRun.current = true;
		try {
			const results: ConfigureResult[] = [];
			const opts = { overwriteBackups: overwrites };
			for (const tool of tools) {
				if (tool === "claude-code") {
					results.push(...configureClaudeCode(apiKey, opts));
				} else if (tool === "opencode") {
					results.push(...configureOpenCode(apiKey, opts));
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
	}, [phase, tools, apiKey, overwrites, onDone]);

	return (
		<Box flexDirection="column">
			{phase === "prompt" && current && (
				<Box flexDirection="column">
					<Text color="cyan">
						{`Backup already exists at ${current.backupPath}`}
					</Text>
					<Text color="cyan">
						{`Overwrite it with the current ${LABEL[current.kind]} contents? [y/N] (${index + 1}/${conflicts.length})`}
					</Text>
				</Box>
			)}
			{logs.map((log, i) => (
				<Text key={`cfg-${i.toString()}`}>{log}</Text>
			))}
			{phase === "done" && (
				<Box marginTop={1} marginBottom={1} flexDirection="column">
					<Text dimColor>{"Run `codev --help` to see all commands."}</Text>
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
