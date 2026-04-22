function link(url: string): string {
	if (!process.stdout.isTTY) return url;
	return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}

export function printHelp() {
	console.log(`CoDev — AI Coding Agent Hub

Usage: codev <command> [options]

Commands:
  install             Install and configure AI coding agents
  claude              Run the Claude Code CLI (${link("https://code.claude.com/docs/en/cli-reference")})
  claude --restore    Restore ~/.claude from ~/.claude.backup
  opencode            Run the OpenCode CLI (${link("https://opencode.ai/docs/cli/")})
  opencode --restore  Restore ~/.config/opencode from ~/.config/opencode.backup
  logout              Sign out of SSO
  --help, -h          Show this help
`);
}
