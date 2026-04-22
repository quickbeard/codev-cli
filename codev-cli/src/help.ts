import { VERSION } from "@/const.js";

function link(url: string): string {
	if (!process.stdout.isTTY) return url;
	return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}

export function printHelp() {
	console.log(`codev v${VERSION} — AI Coding Agent Hub

Usage:
  codev install       Install and configure AI coding agents
  codev claude        Run the Claude Code CLI
                      Docs: ${link("https://code.claude.com/docs/en/cli-reference")}
  codev opencode      Run the OpenCode CLI
                      Docs: ${link("https://opencode.ai/docs/cli/")}
  codev logout        Sign out of SSO
  codev --help, -h    Show this help
`);
}
