# codev-cli

A CLI tool to install and configure coding agents (Claude Code, OpenCode).

## Install

```bash
npm install -g codev-cli
```

Then run:

```bash
codev
```

## Restoring a previous configuration

Before writing its own config, `codev` backs up the directory it would
replace. The backup set depends on which agents you chose in Step 1:

| Selection    | Backed up              |
| ------------ | ---------------------- |
| Claude Code  | `~/.claude/`           |
| OpenCode     | `~/.config/opencode/`  |

If you do **not** select Claude Code, `codev` does not touch `~/.claude/` or
`~/.claude.json` at all. When Claude Code **is** selected, `~/.claude.json` is
read in-place and `"hasCompletedOnboarding": true` is added if missing — the
file is not backed up (only that single flag is touched).

`settings.json` and `opencode.json` are **replaced** (not merged), so any keys
you had before live only in the directory backup.

### Existing backups

If a backup already exists from a prior `codev` run (`*.backup`), `codev`
pauses in Step 3 and asks whether to overwrite it — default is **No**, which
keeps the existing backup (usually your original, pre-`codev` state). Answer
`y` to replace it with your current contents.

### Restore

```bash
# Claude Code
rm -rf ~/.claude && mv ~/.claude.backup ~/.claude

# OpenCode
rm -rf ~/.config/opencode && mv ~/.config/opencode.backup ~/.config/opencode
```

The exact restore command for each backup is also printed in the CLI after
each tool is configured.

## Development

```bash
bun install
bun dev
```

## Build

```bash
bun run build
```

The bundled CLI is output to `dist/index.js`. Run it with:

```bash
bun start
```

## Lint & Format

```bash
bun run fix
```
