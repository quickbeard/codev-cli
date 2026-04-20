import { Box, Text } from "ink";

const VERSION = "0.1.0";

const LOGO = [
	" ██████╗ ██████╗ ██████╗ ███████╗██╗   ██╗",
	"██╔════╝██╔═══██╗██╔══██╗██╔════╝██║   ██║",
	"██║     ██║   ██║██║  ██║█████╗  ██║   ██║",
	"██║     ██║   ██║██║  ██║██╔══╝  ╚██╗ ██╔╝",
	"╚██████╗╚██████╔╝██████╔╝███████╗ ╚████╔╝ ",
	" ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝  ╚═══╝  ",
].join("\n");

const LOGO_WIDTH = 45;

export function Banner() {
	return (
		<Box alignItems="center" justifyContent="center" flexDirection="column">
			<Text bold color="cyan">
				{LOGO}
			</Text>
			<Box marginTop={1} justifyContent="center" width={LOGO_WIDTH}>
				<Text>{"⚡ AI Coding Agent Installer "}</Text>
				<Text dimColor>v{VERSION}</Text>
			</Box>
			<Text dimColor>{"─".repeat(LOGO_WIDTH)}</Text>
		</Box>
	);
}
