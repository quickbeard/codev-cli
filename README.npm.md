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

| Command                    | What it does                                                  |
| -------------------------- | ------------------------------------------------------------- |
| `codev`                    | Show version and help                                         |
| `codev --help`             | Show version and help                                         |
| `codev install`            | Install and configure AI coding agents                        |
| `codev claude`             | Run the `claude` CLI (forwards remaining arguments)           |
| `codev claude --restore`   | Restore `~/.claude` from `~/.claude.backup`                   |
| `codev opencode`           | Run the `opencode` CLI (forwards remaining arguments)         |
| `codev opencode --restore` | Restore `~/.config/opencode` from `~/.config/opencode.backup` |
| `codev logout`             | Sign out of SSO                                               |

## Restoring a previous configuration

CoDev will replace `~/.claude/settings.json` and `~/.config/opencode/opencode.json` with new configs. Before writing its own config, CoDev backs up the directory it would replace.

| Selection   | Backed up                   |
| ----------- | --------------------------- |
| Claude Code | `~/.claude.backup`          |
| OpenCode    | `~/.config/opencode.backup` |

`settings.json` and `opencode.json` are **replaced** (not merged), so any keys you had before live only in the directory backup.

### Existing backups

If a backup already exists from a prior CoDev run (`*.backup`), CoDev pauses in Step 3 and asks whether to overwrite it — default is **No**, which keeps the existing backup (usually your original state). Answer `y` to replace it with your current contents.

### Restore

Use the built-in restore shortcut:

```bash
codev claude --restore
codev opencode --restore
```

Each command removes the active directory and renames the corresponding `*.backup` back into place. If no backup exists, the command prints a "No backup found" message and exits with code 1.

Or do it manually:

```bash
# Claude Code
rm -rf ~/.claude && mv ~/.claude.backup ~/.claude

# OpenCode
rm -rf ~/.config/opencode && mv ~/.config/opencode.backup ~/.config/opencode
```

The restore command for each backup is also printed in the CLI after each tool is configured.
