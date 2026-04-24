import { VERSION } from "@/const.js";

function link(url: string): string {
	if (!process.stdout.isTTY) return url;
	return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}

export function printVersion() {
	console.log(`${VERSION}`);
}

export function printHelp() {
	console.log(`CoDev — AI Coding Agent Hub

Usage: codev <command> [options]

Commands:
  install             Install and configure AI coding agents
  update              Update installed AI coding agents
  claude              Run the Claude Code CLI (${link("https://code.claude.com/docs/en/cli-reference")})
  claude --restore    Restore ~/.claude/settings.json from ~/.claude/settings.json.backup
  opencode            Run the OpenCode CLI (${link("https://opencode.ai/docs/cli")})
  opencode --restore  Restore ~/.config/opencode/opencode.json from ~/.config/opencode/opencode.json.backup
  logout              Sign out of SSO
  --version, -v       Show version
  --help, -h          Show this help
`);
}
