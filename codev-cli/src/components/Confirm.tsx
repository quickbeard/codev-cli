import { Box, Text, useInput } from "ink";
import { getBackupStatus, type Tool } from "@/setup.js";

interface ConfirmProps {
	tools: Tool[];
	onConfirm: (proceed: boolean) => void;
}

const TOOL_LABEL: Record<Tool, string> = {
	"claude-code": "Claude Code",
	opencode: "OpenCode",
};

const CONFIG_FILE: Record<Tool, string> = {
	"claude-code": "settings.json",
	opencode: "opencode.json",
};

export function Confirm({ tools, onConfirm }: ConfirmProps) {
	useInput((input, key) => {
		const answer = input.toLowerCase();
		if (answer === "y") {
			onConfirm(true);
		} else if (answer === "n" || key.return) {
			onConfirm(false);
		}
	});

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text bold>
				{"⚠️  "}
				<Text color="yellow">Heads up</Text>
				{" — codev will replace existing settings for the tools you chose:"}
			</Text>
			{tools.map((tool) => {
				const [status] = getBackupStatus(tool);
				if (!status) return null;
				const target = `${status.sourcePath}/${CONFIG_FILE[tool]}`;
				return (
					<Box key={tool} flexDirection="column" marginTop={1}>
						<Text>{`  • ${TOOL_LABEL[tool]}`}</Text>
						<Text>
							{`    Replaces: ${target}${status.hasSource ? " (exists)" : " (new)"}`}
						</Text>
						{status.hasSource && (
							<Text>
								{`    Backup:   ${status.sourcePath} → ${status.backupPath}`}
							</Text>
						)}
						<Text>
							{`    Restore:  rm -rf ${status.sourcePath} && mv ${status.backupPath} ${status.sourcePath}`}
						</Text>
					</Box>
				);
			})}
			<Box marginTop={1}>
				<Text color="cyan">{"  Continue? [y/N]"}</Text>
			</Box>
		</Box>
	);
}
