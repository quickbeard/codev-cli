# CoDev

CoDev — AI Coding Agent Hub. Install, configure, and manage multiple AI coding agents.

Requires Node.js ≥ 22.21 (Node 24+ recommended).

## Install

```bash
npm install -g codev-ai
```

Then run:

```bash
codevhub doctor    # check your environment and network first
codevhub install
```

After install, go to your project and type `codev`, `claude`, `codex`, or `opencode` to launch.

## Check your setup first: `codevhub doctor`

On a corporate network — behind a proxy, a TLS-inspecting gateway, or an
internal npm mirror — run this before `codevhub install`:

```bash
codevhub doctor
codevhub doctor --force    # also force a real sign-in instead of reusing the cached session
```

It is read-only (it installs and configures nothing) and checks, in order:

- **Environment** — Node version, whether your terminal can accept keyboard
  input, npm, the global npm prefix (on `PATH` and writable), the npm
  registry/proxy configuration, your proxy and TLS environment variables, and
  whether the OS certificate store is readable.
- **Network** — the CoDev backend and the npm registry are actually reachable.
- **Account** — sign-in, gateway API key, CoDev configuration, and the analysis
  backend (used by `codevhub upload`).
- **LLM access** — the key is valid, models are listable, and a real one-token
  completion succeeds. Only the last of these proves inference is permitted;
  `/key/info` and `/v1/models` both pass for a key that is then 403'd on every
  completion.
- **This machine** — what is already installed, configured, and backed up.

Failures expand in place into what happened, the most likely cause given your
proxy and TLS settings, the fix, and the raw error chain — never a bare
`fetch failed`. If the network checks fail it offers to re-run everything
through a proxy you type in (nothing is written to disk), so you see the fix
work before it prints the exact `export` / `setx` commands to make it permanent.

Exit code is 0 when nothing failed — warnings do not fail it — and 1 otherwise.

Every run also writes a machine-readable report to
**`~/.codev-hub/doctor-report.json`**, replacing the previous one. It holds the
full results, diagnoses, your Node and proxy environment, and the suggested next
steps — attach it to a support ticket rather than pasting screenshots. Secrets
are scrubbed before it is written. The same results additionally land in the
diagnostic log, so `codevhub logs` can replay a whole run.

### Working behind a proxy

Node does **not** honor `HTTP_PROXY`/`HTTPS_PROXY` on its own — it needs
`NODE_USE_ENV_PROXY=1`, read at startup. CoDev applies that for you when it sees
a proxy configured, but it is worth setting permanently:

```bash
export HTTP_PROXY=http://<PROXY-IP>:<PROXY-PORT>
export HTTPS_PROXY=http://<PROXY-IP>:<PROXY-PORT>
export NODE_USE_ENV_PROXY=1
export NODE_USE_SYSTEM_CA=1
```

Two traps `codevhub doctor` will catch for you:

- **`NO_PROXY` covering the CoDev backend** (for example a blanket
  `*.viettel.vn`) routes sign-in traffic *around* the proxy and straight into
  the firewall. This is the usual cause of `Login failed`.
- **npm keeps its own proxy and TLS configuration**, separate from these
  variables — `npm config set proxy`, `https-proxy`, `cafile`, `registry`. A
  working `codevhub` says nothing about whether `npm i -g` will work.

## CodeGraph integration

When you run `codevhub install` or `codevhub config`, CoDev also installs [CodeGraph](https://github.com/colbymchenry/codegraph) — a local, MCP-based, pre-indexed code-knowledge-graph tool — and wires it into each agent you select (Claude Code, Codex, OpenCode, etc.). Because your codebase is pre-indexed, agents can look up symbols, references, and structure straight from the graph instead of repeatedly grepping and reading files to find their way around. That means **fewer tool calls and fewer tokens** per task — the agent spends its context on the work rather than on rediscovering the codebase.

### Initialize your project

```bash
cd your-project
codevhub init        # initialize + index the current project (one time)
```

## CoDev Office skills (offline bundle)

`codevhub skill office` installs the CoDev Office skills so your agents can create, read and edit real DOCX, XLSX, PPTX and PDF files. Everything ships in one offline bundle — no login and no per-skill downloads:

```bash
codevhub skill office
```

It picks the bundle for your OS — on macOS, for your chip: Apple Silicon and Intel get separate bundles — and downloads it into `~/.codev-hub/office` (on Windows: `%PUBLIC%\Downloads\codev-office`). On macOS/Linux it then runs the bundled setup script, which may prompt for `sudo`; on Windows it prints the exact command to paste into an elevated PowerShell instead of launching the installer itself.

**The bundle is large**, and the command prints its approximate size before downloading. The download folder is kept between runs, so an interrupted transfer resumes where it left off and an already-downloaded bundle is reused. To force a completely fresh download, delete that folder.

To fetch the bundle now and install later — or to stage it for a machine that has no internet access:

```bash
codevhub skill office --download-only                 # download for this OS, don't install
codevhub skill office --platform windows              # download another OS's bundle (implies --download-only)
codevhub skill office --platform macos --arch arm64   # macOS needs a chip: arm64 or x86_64
codevhub skill office --dir /media/usb/codev-office   # download somewhere else
```

Because macOS has one bundle per chip, `--platform macos` from a non-Mac also needs `--arch arm64` or `--arch x86_64` — nothing on a Linux or Windows host implies which Mac the bundle is for. On a Mac the chip is detected for you (including through Rosetta), and `--arch` is only needed to stage a bundle for the *other* chip. There is still a single macOS setup script: it resolves its own bundle from `uname -m`.

Both files land side by side, and the command prints the exact line to run from that folder (`bash codev-office-<os>-setup.sh`, or `powershell -ExecutionPolicy Bypass -File .\codev-office-windows-setup.ps1`). A bundle downloaded for another OS is never executed on this machine.

Two flags are passed straight through to the setup script: `--skip-verify` (skip the bundle's own SHA-256 check) and `--force-skills` (replace already-installed skills with the bundled versions).

## Switching between self-hosted and proprietary models

CoDev points your agents at a self-hosted AI gateway, but you can flip any agent back to its own provider (Anthropic for Claude Code, OpenAI for Codex, and so on) — and back to the gateway again — whenever you like. Because CoDev backs up your original config before it changes anything, the round-trip is safe and repeatable.

### Go back to the proprietary models

Restore each agent's pre-CoDev config:

```bash
codevhub restore claude     # one agent
codevhub restore codex
codevhub restore opencode
codevhub restore            # every agent at once
```

`codevhub restore <agent>` swaps the backup back over the live config, so the agent talks to its own provider again. With no argument, `codevhub restore` reverts every agent at once.

### Use the self-hosted models

Re-point your already-installed agents at the gateway and pick a model:

```bash
codevhub config
```

After each switching, if you have a session running, you might need to restart it with `claude -c`, `codex resume`, or `opencode -c` to resume your progress.

## Removing CoDev entirely

```bash
codevhub remove
```

After confirmation, this reverts your machine to its pre-CoDev state — including running `codegraph uninstall` to remove CodeGraph's MCP wiring from your agents. Add `--yes` (or `-y`) to skip the confirmation prompt.

CoDev itself is still installed globally — finish with:

```bash
npm uninstall -g codev-ai
```

Then restart your terminal.

## Diagnostic logs

Every codevhub command appends a structured diagnostic log to `~/.codev-hub/logs/codev-YYYYMMDD.ndjson` — one [Elastic Common Schema](https://www.elastic.co/guide/en/ecs/current/index.html) JSON document per line. If a command misbehaves, this file shows what actually happened: each network request with its status and duration, every child process with its exit code and stderr tail, step-by-step flow progress, and any crash with a stack trace.

```bash
codevhub logs               # pretty-print the most recent run
codevhub logs --verbose     # also show each entry's codev.* detail (api_key, endpoints, …)
codevhub logs --trace <id>  # drill into one run (child runs are listed by the output above)
codevhub logs --path        # print the newest log file's path

# Or query the raw NDJSON directly — everything from today's failed runs:
jq 'select(.log.level == "error" or .log.level == "warn")' "$(codevhub logs --path)"
```

Details worth knowing:

- **Conversations are never logged, and most secrets are redacted.** OAuth codes, bearer tokens, JWTs, and signed-URL parameters are scrubbed twice over, and agent prompt text is never recorded (only argument counts). **One deliberate exception:** the gateway API key you configure during `codevhub install` / `codevhub config` is written to the log in cleartext (as the `configure.api-key` event, surfaced by `codevhub logs --verbose`) so a misconfigured key can be diagnosed — treat `~/.codev-hub/logs` as sensitive. Conversation exports are separate data and live in `~/.codev-hub/agent-logs/`.
- **Retention** is automatic: files older than 14 days are pruned, and the directory is capped at 50 MB.
- **Tuning:** `CODEV_LOG_LEVEL` (`debug` by default; `silent` disables logging), `CODEV_LOG_DIR` relocates the directory.

## Agent readiness

Run `codevhub readiness` from a Git repository to choose Claude Code, Codex, or
OpenCode and start a headless, read-only readiness evaluation. CoDev validates
the agent's evidence against its versioned rubric, computes scores locally,
rejects scans that change the working tree, and uploads the validated report.
The report is a local agent evaluation, not a server-verified audit.

Readiness uses each harness's configured default model for Claude Code and
Codex; `codevhub readiness --model <model-id>` provides a one-off override for
those harnesses. OpenCode readiness always uses
`aigateway/MiniMax/MiniMax-M2.7`. Repair, timeout, and output limits are bounded
product safeguards rather than user configuration. The selected harness must
first be configured through `codevhub install`.

The rubric version is deliberately not configurable: it identifies the actual
report schema and scoring rubric shared by CLI, proxy, and dashboard.

## Development

```bash
corepack enable
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
```

The bundled CLI is output to `dist/index.js`. Run it with:

```bash
pnpm start
```

## Lint & Format

```bash
pnpm fix
pnpm typecheck
```

## Test

```bash
pnpm test
```
