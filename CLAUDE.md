---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## React

When writing or reviewing React components, follow the Vercel React best practices defined in `.claude/skills/vercel-react-best-practices/`. Refer to `SKILL.md` for the rule index and read individual rule files in `rules/` for detailed examples.

## Imports

Use absolute imports with the `@/*` alias. Don't use relative imports.

```ts
// Good
import { App } from "@/App.js";
import { Banner } from "@/components/Banner.js";

// Bad
import { App } from "./App.js";
import { Banner } from "../components/Banner.js";
```

## Validation

Always run these commands after making changes and ensure they pass:

- `bun run fix` — lint and format with Biome
- `bun run typecheck` — type-check with TypeScript
- `bun test` — run tests
- `bun run build` — bundle the CLI for distribution

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Backup behavior

`configureClaudeCode` and `configureOpenCode` always replace the live config (`~/.claude/settings.json`, `~/.config/opencode/opencode.json`), but an existing `*.backup` is never overwritten. On the first run a backup is copied from the live config; every subsequent run skips the backup step and leaves the original `*.backup` in place. There is no prompt and no `overwriteBackups` option — preserving the user's pre-CoDev state is the whole point. `restoreTool` then renames `*.backup` back over the live file.
