# CoDev

CoDev — AI Coding Agent Hub. Install, configure, and manage AI coding agents (Claude Code, OpenCode, etc.) from a single CLI.

## Install

```bash
npm install -g codev-ai
```

Then run:

```bash
codev install
```

## Commands

| Command                    | What it does                                                   |
| -------------------------- | -------------------------------------------------------------- |
| `codev`                    | Show version and help                                          |
| `codev --help`             | Show version and help                                          |
| `codev install`            | Install and configure AI coding agents                         |
| `codev claude`             | Run the `claude` CLI (forwards remaining arguments)            |
| `codev claude --restore`   | Restore `~/.claude/` from `~/.claude.backup/`                  |
| `codev opencode`           | Run the `opencode` CLI (forwards remaining arguments)          |
| `codev opencode --restore` | Restore `~/.config/opencode/` from `~/.config/opencode.backup` |
| `codev logout`             | Sign out of SSO                                                |

## Restoring a previous configuration

Before writing its own config, `codev` backs up the directory it would
replace. The backup set depends on which agents you chose in Step 1:

| Selection   | Backed up             |
| ----------- | --------------------- |
| Claude Code | `~/.claude/`          |
| OpenCode    | `~/.config/opencode/` |

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

Use the built-in restore shortcut:

```bash
codev claude --restore
codev opencode --restore
```

Each command removes the active directory and renames the corresponding
`*.backup` back into place. If no backup exists, the command prints a
"No backup found" message and exits with code 1.

Or do it manually:

```bash
# Claude Code
rm -rf ~/.claude && mv ~/.claude.backup ~/.claude

# OpenCode
rm -rf ~/.config/opencode && mv ~/.config/opencode.backup ~/.config/opencode
```

The restore command for each backup is also printed in the CLI after each
tool is configured.
