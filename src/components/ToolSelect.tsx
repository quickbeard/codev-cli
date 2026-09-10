import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Tool } from "@/lib/configure.js";

// Sentinel values emitted when the user picks an editor-extension row.
// InstallApp expands them via the merged EditorSelect sub-step into the
// editor-specific Tool values (e.g. `vscode-claude-code` /
// `jetbrains-continue`). Two separate sentinels (one per extension) let
// downstream code know which extension(s) the editor choice applies to.
export const CLAUDE_CODE_EXT_SENTINEL = "claude-code-ext" as const;
export const CONTINUE_SENTINEL = "continue" as const;
export type ToolSelectSentinel =
	| typeof CLAUDE_CODE_EXT_SENTINEL
	| typeof CONTINUE_SENTINEL;
export type ToolSelectValue = Tool | ToolSelectSentinel;

const TOOLS: { label: string; value: ToolSelectValue; locked?: boolean }[] = [
	// CoDev Code is the flagship agent — always installed and configured, so its
	// row is shown pre-checked and can't be toggled off. Kept at index 0 so the
	// optional agents keep their positions.
	{ label: "CoDev Code", value: "codev-code", locked: true },
	{ label: "Claude Code", value: "claude-code" },
	{ label: "Codex", value: "codex" },
	{ label: "OpenCode", value: "opencode" },
	{ label: "Claude Code (extension)", value: CLAUDE_CODE_EXT_SENTINEL },
	{ label: "Continue (extension)", value: CONTINUE_SENTINEL },
];

// Locked tools are emitted on every confirm regardless of the mutable
// selection, and always lead the emitted list.
const LOCKED_VALUES: ToolSelectValue[] = TOOLS.filter((t) => t.locked).map(
	(t) => t.value,
);

interface ToolSelectProps {
	onConfirm: (tools: ToolSelectValue[]) => void;
	readOnly?: boolean;
	mode?: "install" | "config";
}

export function ToolSelect({
	onConfirm,
	readOnly = false,
	mode = "install",
}: ToolSelectProps) {
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState<Set<ToolSelectValue>>(new Set());

	useInput(
		(input, key) => {
			if (key.upArrow) {
				setCursor((c) => Math.max(0, c - 1));
			} else if (key.downArrow) {
				setCursor((c) => Math.min(TOOLS.length - 1, c + 1));
			} else if (input === " ") {
				const tool = TOOLS[cursor];
				// Locked rows (CoDev Code) are always included and can't be toggled.
				if (!tool || tool.locked) return;
				setSelected((prev) => {
					const next = new Set(prev);
					if (next.has(tool.value)) {
						next.delete(tool.value);
					} else {
						next.add(tool.value);
					}
					return next;
				});
			} else if (key.return) {
				// The locked defaults guarantee a non-empty selection, so Enter
				// always proceeds — even with no optional agents picked.
				onConfirm([...LOCKED_VALUES, ...selected]);
			}
		},
		{ isActive: !readOnly },
	);

	const lockedSuffix =
		mode === "config" ? " (always configured)" : " (always installed)";

	return (
		<Box flexDirection="column">
			{TOOLS.map((tool, i) => {
				const isSelected = tool.locked || selected.has(tool.value);
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
						{tool.locked && <Text dimColor>{lockedSuffix}</Text>}
					</Box>
				);
			})}
		</Box>
	);
}

export function toolSelectTitle(
	readOnly = false,
	mode: "install" | "config" = "install",
) {
	const verb = mode === "install" ? "install" : "configure";
	return (
		<Text bold>
			{`Select the AI agent(s) to ${verb} `}
			{!readOnly && (
				<Text dimColor>(↑/↓ to move, Space to select, Enter to confirm)</Text>
			)}
		</Text>
	);
}
