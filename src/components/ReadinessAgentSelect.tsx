import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useCanType } from "@/components/useCanType.js";
import {
	READINESS_AGENTS,
	type ReadinessAgent,
} from "@/lib/readiness-agent.js";

const LABELS: Record<ReadinessAgent, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
};

interface ReadinessAgentSelectProps {
	available: Record<ReadinessAgent, boolean>;
	selected?: ReadinessAgent | null;
	readOnly?: boolean;
	onSelect: (agent: ReadinessAgent) => void;
}

export function ReadinessAgentSelect({
	available,
	selected = null,
	readOnly = false,
	onSelect,
}: ReadinessAgentSelectProps) {
	const firstAvailable = Math.max(
		0,
		READINESS_AGENTS.findIndex((agent) => available[agent]),
	);
	const [cursor, setCursor] = useState(firstAvailable);
	const canType = useCanType();

	useInput(
		(_input, key) => {
			if (key.upArrow || key.downArrow) {
				const direction = key.upArrow ? -1 : 1;
				for (let step = 1; step <= READINESS_AGENTS.length; step++) {
					const next =
						(cursor + direction * step + READINESS_AGENTS.length) %
						READINESS_AGENTS.length;
					const candidate = READINESS_AGENTS[next];
					if (candidate && available[candidate]) {
						setCursor(next);
						break;
					}
				}
			} else if (key.return) {
				const choice = READINESS_AGENTS[cursor];
				if (choice && available[choice]) onSelect(choice);
			}
		},
		{ isActive: canType && !readOnly },
	);

	return (
		<Box flexDirection="column">
			{READINESS_AGENTS.map((agent, index) => {
				const enabled = available[agent];
				const chosen = selected === agent;
				const active = !readOnly && cursor === index && enabled;
				return (
					<Box key={agent}>
						<Text color={chosen ? "green" : enabled ? undefined : "gray"}>
							{chosen ? "●" : "○"}
						</Text>
						<Text> </Text>
						<Text bold={active} dimColor={!active && !chosen}>
							{LABELS[agent]}
							{enabled ? "" : " (unavailable)"}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

export function readinessAgentSelectTitle(readOnly = false) {
	return (
		<Text bold>
			{"Choose coding agent "}
			{!readOnly && <Text dimColor>(↑/↓ to move, Enter to confirm)</Text>}
		</Text>
	);
}
