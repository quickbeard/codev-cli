import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";

export interface TaskItem {
	key: string;
	label: string;
	run: () => Promise<string | null>;
}

export interface TaskVerb {
	// e.g. { infinitive: "install", present: "Installing", past: "Installed" }
	infinitive: string;
	present: string;
	past: string;
}

type Status = "pending" | "running" | "done" | "failed";

interface Row {
	key: string;
	label: string;
	status: Status;
	error?: string;
}

interface TaskListProps {
	tasks: TaskItem[];
	verb: TaskVerb;
	onDone: (success: boolean) => void;
}

export function TaskList({ tasks, verb, onDone }: TaskListProps) {
	const [rows, setRows] = useState<Row[]>(() =>
		tasks.map((t) => ({ key: t.key, label: t.label, status: "pending" })),
	);
	const hasRun = useRef(false);
	const hasReported = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		setRows((prev) => prev.map((r) => ({ ...r, status: "running" })));
		for (const [i, task] of tasks.entries()) {
			task.run().then((err) => {
				setRows((prev) =>
					prev.map((r, idx) =>
						idx === i
							? {
									...r,
									status: err ? "failed" : "done",
									error: err ?? undefined,
								}
							: r,
					),
				);
			});
		}
	}, [tasks]);

	// Fire onDone only after React has committed the terminal status for every
	// task. Calling onDone inside the run-promise chain races the final commit:
	// the parent's exit() can unmount the tree before Ink flushes the last
	// "done"/"failed" frame to the terminal.
	useEffect(() => {
		if (hasReported.current) return;
		if (rows.length === 0) return;
		const allSettled = rows.every(
			(r) => r.status === "done" || r.status === "failed",
		);
		if (!allSettled) return;
		hasReported.current = true;
		onDone(rows.every((r) => r.status === "done"));
	}, [rows, onDone]);

	return (
		<Box flexDirection="column">
			{rows.map((row) => (
				<TaskRow key={row.key} row={row} verb={verb} />
			))}
		</Box>
	);
}

function TaskRow({ row, verb }: { row: Row; verb: TaskVerb }) {
	return (
		<Box>
			<Box marginRight={1}>
				<StatusIcon status={row.status} />
			</Box>
			<Text>{rowText(row, verb)}</Text>
		</Box>
	);
}

function rowText(row: Row, verb: TaskVerb): string {
	switch (row.status) {
		case "running":
			return `${verb.present} ${row.label}...`;
		case "done":
			return `${verb.past} ${row.label}`;
		case "failed":
			return `Failed to ${verb.infinitive} ${row.label}: ${row.error ?? "unknown error"}`;
		default:
			return row.label;
	}
}

function StatusIcon({ status }: { status: Status }) {
	if (status === "running") {
		return (
			<Text color="cyan">
				<Spinner />
			</Text>
		);
	}
	if (status === "done") return <Text color="green">✓</Text>;
	if (status === "failed") return <Text color="red">✗</Text>;
	return <Text dimColor>○</Text>;
}
