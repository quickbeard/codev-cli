import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Tool } from "@/configure.js";

const TOOLS: { label: string; value: Tool }[] = [
	{ label: "Claude Code", value: "claude-code" },
	{ label: "OpenCode", value: "opencode" },
];

interface ToolSelectProps {
	onConfirm: (tools: Tool[]) => void;
	readOnly?: boolean;
}

export function ToolSelect({ onConfirm, readOnly = false }: ToolSelectProps) {
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState<Set<Tool>>(new Set());

	useInput(
		(input, key) => {
			if (key.upArrow) {
				setCursor((c) => Math.max(0, c - 1));
			} else if (key.downArrow) {
				setCursor((c) => Math.min(TOOLS.length - 1, c + 1));
			} else if (input === " ") {
				setSelected((prev) => {
					const next = new Set(prev);
					const tool = TOOLS[cursor];
					if (!tool) return next;
					if (next.has(tool.value)) {
						next.delete(tool.value);
					} else {
						next.add(tool.value);
					}
					return next;
				});
			} else if (key.return) {
				if (selected.size === 0) return;
				onConfirm([...selected]);
			}
		},
		{ isActive: !readOnly },
	);

	return (
		<Box flexDirection="column">
			{TOOLS.map((tool, i) => {
				const isSelected = selected.has(tool.value);
				const isCursor = !readOnly && cursor === i;
				return (
					<Box key={tool.value}>
						<Text color={isSelected ? "green" : undefined}>
							{isSelected ? "■" : "□"}
						</Text>
						<Text> </Text>
						<Text bold={isCursor} dimColor={!isCursor}>
							{tool.label}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

export function toolSelectTitle(readOnly = false) {
	return (
		<Text bold>
			{"Select the AI agent(s) to install "}
			{!readOnly && <Text dimColor>(space to toggle, enter to confirm)</Text>}
		</Text>
	);
}
