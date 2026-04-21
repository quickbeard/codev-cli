import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Tool } from "@/setup.js";

const TOOLS: { label: string; icon: string; value: Tool }[] = [
	{ label: "Claude Code", icon: "🤖", value: "claude-code" },
	{ label: "OpenCode", icon: "💻", value: "opencode" },
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
		<Box marginTop={1} flexDirection="column">
			<Text bold>
				{"📋 "}
				<Text color="yellow">Step 1/3</Text>
				{" — Select the AI agent(s) to install and configure:"}
			</Text>
			{!readOnly && (
				<Text dimColor>
					{"\n"}Use ↑/↓ to navigate, Space to select, Enter to confirm
				</Text>
			)}
			<Box flexDirection="column" marginTop={1}>
				{TOOLS.map((tool, i) => {
					const isSelected = selected.has(tool.value);
					const isCursor = !readOnly && cursor === i;
					const pointer = readOnly ? " " : isCursor ? "❯" : " ";
					return (
						<Box key={tool.value}>
							<Text bold color={isCursor ? "yellow" : undefined}>
								{pointer}{" "}
							</Text>
							<Text>{tool.icon} </Text>
							<Text
								color={isCursor ? "yellow" : isSelected ? "green" : undefined}
								bold={isCursor}
							>
								{tool.label}
							</Text>
							{isSelected && <Text color="green"> ✔</Text>}
						</Box>
					);
				})}
			</Box>
		</Box>
	);
}
