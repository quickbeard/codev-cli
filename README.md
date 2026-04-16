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

## Development

```bash
bun install
bun dev
```

## Build

```bash
bun run build
```

The bundled CLI is output to `dist/index.js`. Test it with:

```bash
node dist/index.js
```

## Lint & Format

```bash
bun run fix
```
