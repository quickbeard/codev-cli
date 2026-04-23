import { Box, Text, useInput } from "ink";
import { getBackupStatus, type Tool } from "@/configure.js";

interface ConfirmProps {
	tools: Tool[];
	onConfirm: (proceed: boolean) => void;
	readOnly?: boolean;
}

const TOOL_LABEL: Record<Tool, string> = {
	"claude-code": "Claude Code",
	opencode: "OpenCode",
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
				return (
					<Box key={tool} flexDirection="column">
						<Text>{`• ${TOOL_LABEL[tool]}`}</Text>
						<Text>
							{`  Replaces: ${status.sourcePath}${status.hasSource ? " (exists)" : " (new)"}`}
						</Text>
						{status.hasSource && (
							<Text>
								{`  Backup:   ${status.sourcePath} → ${status.backupPath}`}
							</Text>
						)}
						<Text>
							{"  You can revert to your previous settings by running "}
							<Text color="cyan">{RESTORE_CMD[tool]}</Text>
							{". You might need to restart your current session."}
						</Text>
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
				"Heads up — CoDev will back up your existing settings and replace them with new settings."
			}
		</Text>
	);
}
