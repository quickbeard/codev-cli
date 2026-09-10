import { VERSION } from "@/lib/const.js";

export function printVersion() {
	console.log(`${VERSION}`);
}

export function printHelp() {
	console.log(`CoDev — AI Coding Agent Hub

Usage: codevhub [command] [options]

Bare \`codevhub\` opens CoDev Code, the built-in coding agent, in the current
directory (\`codev\` opens it directly). Any command not listed below is
passed through to it as well — \`codevhub run "fix the tests"\`,
\`codevhub serve\`, \`codevhub models\`, and so on.

Hub commands:
  doctor              Check your environment and network before installing
                      (Node version, npm, proxy/TLS, sign-in, LLM access;
                      --force to test a real sign-in instead of the cached one)
  install             Install and configure AI coding agents
  config              Configure existing AI coding agents
  update              Update installed AI coding agents
  init                Build the knowledge graph
  upload              Export and upload logs to the monitor module
                      (--force, -f re-uploads every conversation)
  model               Switch the default model
  readiness           Analyze and upload readiness for the current repository
                      (--profile <id-or-slug>, --agent <claude|codex|opencode>,
                      --model <model-id> for Claude Code or Codex)
  restore [agent]     Restore an agent's pre-CoDev config
                      (no arg processes every agent)
  logs                Show the last run from the diagnostic log
                      (--path newest file, --trace <id> one run, --verbose extra detail)
  login               Sign in to SSO (--force to bypass cached session,
                      --admin for interactive admin sign-in, or
                      --username <u> --password <p> for non-interactive admin sign-in)
  logout              Sign out (SSO and admin session)
  remove              Revert this machine to its pre-CoDev state (--yes to skip prompt)
  --version, -v       Show version
  --help, -h          Show this help

Skill hub:
  skill search <query>   Search the public skill hub
                         (--json for machine-readable output,
                         --limit <n> to cap results, default 20)
  skill pull <name>      Download and install a skill for your agents
                         (prompts for location and agents; --here or --global to
                         set the scope, --agent <list> or --all-agents to set the
                         agents, --dir <path> for an exact path, --force to
                         overwrite; --json for machine-readable output)
  skill push <path>      Publish a skill (a directory with SKILL.md, or a .zip)
                         (previews and confirms before upload; --draft-only to stop
                         at DRAFT, --auto-approve for admins, --json for output)
  skill office           Download the CoDev Office offline skills bundle
                         (create, read and edit DOCX, XLSX, PPTX and PDF)
                         for this OS and run its setup script
                         (--platform ubuntu|macos|windows to fetch for another OS
                         [implies --download-only], --arch arm64|x86_64 to pick
                         the macOS chip's bundle [required when fetching a macOS
                         bundle from another OS], --dir <path> for the download
                         folder, --download-only to skip running the installer,
                         --skip-verify passed through to the installer,
                         --force-skills to replace already-installed skills
                         with the bundled versions)
`);
}
