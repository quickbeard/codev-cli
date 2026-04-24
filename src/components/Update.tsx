import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { TaskList } from "@/components/TaskList.js";
import type { Tool } from "@/configure.js";
import { detectInstalledViaNpm, installAndVerify, PKG } from "@/npm.js";

const ALL_TOOLS: Tool[] = ["claude-code", "opencode"];

type Phase =
	| { kind: "detecting" }
	| { kind: "nothing" }
	| { kind: "updating"; tools: Tool[] };

interface UpdateProps {
	onDone: (success: boolean) => void;
}

export function Update({ onDone }: UpdateProps) {
	const [phase, setPhase] = useState<Phase>({ kind: "detecting" });
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		(async () => {
			const flags = await Promise.all(
				ALL_TOOLS.map((t) => detectInstalledViaNpm(t)),
			);
			const detected = ALL_TOOLS.filter((_, i) => flags[i]);
			if (detected.length === 0) {
				setPhase({ kind: "nothing" });
				onDone(true);
				return;
			}
			setPhase({ kind: "updating", tools: detected });
		})();
	}, [onDone]);

	if (phase.kind === "detecting") {
		return (
			<Box>
				<Box marginRight={1}>
					<Text color="cyan">
						<Spinner />
					</Text>
				</Box>
				<Text>Checking installed agents...</Text>
			</Box>
		);
	}

	if (phase.kind === "nothing") {
		return <Text>No agents installed via npm — nothing to update.</Text>;
	}

	const tasks = phase.tools.map((tool) => ({
		key: tool,
		label: PKG[tool],
		run: () => installAndVerify(tool),
	}));
	return (
		<TaskList
			tasks={tasks}
			verb={{ infinitive: "update", present: "Updating", past: "Updated" }}
			onDone={onDone}
		/>
	);
}
