import { Box, Text, useInput } from "ink";
import { getBackupStatus, type Tool } from "@/setup.js";

interface ConfirmProps {
	tools: Tool[];
	onConfirm: (proceed: boolean) => void;
	readOnly?: boolean;
}

const TOOL_LABEL: Record<Tool, string> = {
	"claude-code": "Claude Code",
	opencode: "OpenCode",
};

const CONFIG_FILE: Record<Tool, string> = {
	"claude-code": "settings.json",
	opencode: "opencode.json",
};

const RESTORE_CMD: Record<Tool, string> = {
	"claude-code": "codev claude --restore",
	opencode: "codev opencode --restore",
};

export function Confirm({ tools, onConfirm, readOnly = false }: ConfirmProps) {
	useInput(
		(input, key) => {
			const answer = input.toLowerCase();
			if (answer === "y") {
				onConfirm(true);
			} else if (answer === "n" || key.return) {
				onConfirm(false);
			}
		},
		{ isActive: !readOnly },
	);

	return (
		<Box flexDirection="column">
			{tools.map((tool) => {
				const [status] = getBackupStatus(tool);
				if (!status) return null;
				const target = `${status.sourcePath}/${CONFIG_FILE[tool]}`;
				return (
					<Box key={tool} flexDirection="column">
						<Text>{`• ${TOOL_LABEL[tool]}`}</Text>
						<Text>
							{`  Replaces: ${target}${status.hasSource ? " (exists)" : " (new)"}`}
						</Text>
						{status.hasSource && (
							<Text>
								{`  Backup:   ${status.sourcePath} → ${status.backupPath}`}
							</Text>
						)}
						<Text>{`  Restore:  ${RESTORE_CMD[tool]}`}</Text>
					</Box>
				);
			})}
			{!readOnly && (
				<Box marginTop={1}>
					<Text color="cyan">Continue? [y/N]</Text>
				</Box>
			)}
		</Box>
	);
}

export function confirmTitle() {
	return (
		<Text bold color="yellow">
			{
				"Heads up — CoDev will replace existing settings for the tools you chose"
			}
		</Text>
	);
}
