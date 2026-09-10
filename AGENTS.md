---
description: Node-only CLI; pnpm + tsx + vitest + esbuild.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

This is a Node.js project. The shipped bin (`dist/index.js`) runs under plain Node, and the dev/build/test toolchain runs under Node too.

- Use `pnpm` for installs, scripts, and `pnpm exec`. Don't use `npm`/`yarn`/`bun install`.
- Use `tsx <file>` to run TypeScript/TSX directly (e.g. `pnpm dev` → `tsx src/index.tsx`). Don't use `ts-node`. The dev script is one-shot, not watch — codev is an interactive Ink CLI, so respawning mid-flow would corrupt the TTY.
- Use `vitest` for tests (`pnpm test`). Don't use `jest`.
- Use `esbuild` for bundling (driven by `build.ts` via `pnpm build`). Don't use `webpack`/`rollup`/`Bun.build`.
- Use `.env` via Node's built-in support (`node --env-file=.env`) or a per-script setup. Don't add `dotenv`.

## React

When writing or reviewing React/Ink components, consult the Vercel React best practices at `.claude/skills/vercel-react-best-practices/`. The rule index is `SKILL.md`; individual rules live in `rules/`, grouped by filename prefix:

- `advanced-*` — advanced hook patterns (effect event deps, event handler refs, init-once, use-latest)
- `async-*` — async/await and suspense (cheap-condition-before-await, defer-await, dependencies, parallel, suspense boundaries, API routes)
- `bundle-*` — bundle size (analyzable paths, barrel imports, conditional loading, dynamic imports, preload, deferring third-party)
- `client-*` — client-side browser concerns (event listeners, passive listeners, localStorage schema, SWR dedup)
- `js-*` — general JS perf (DOM/CSS batching, caching storage/props/results, early exit, hoisting regex, index maps, set/map lookups, toSorted, combining iterations, length-check first, requestIdleCallback)
- `rendering-*` — render-path optimizations (activity, content-visibility, hoisting JSX, hydration flicker/warnings, resource hints, defer/async scripts, SVG precision, useTransition for loading)
- `rerender-*` — re-render reduction (memo, derived state, functional setState, dependency lists, lazy state init, deferred reads, inline components, split hooks, transitions, useDeferredValue, useRef transient values, move-effect-to-event)
- `server-*` — SSR/server (after-nonblocking, auth actions, cache LRU/React, dedup props, hoist static I/O, no shared module state, parallel fetching, serialization)

Load a specific rule file only when the current work touches that topic; don't blanket-load the whole skill.

## Layout

The CLI is layered. Each layer has one job and only depends on the layer below it:

- `src/index.tsx` — argv dispatcher. Maps each command to its app component or logic function and exits.
- `src/<Name>App.tsx` — command-root Ink components, one per command (`InstallApp`, `UpdateApp`, `UploadApp`). Each is a state machine that wires together components from `src/components/` and orchestrates the command's flow. `index.tsx` mounts these via `render(<XApp />)`.
- `src/components/*.tsx` — reusable Ink components (Banner, Frame, Step, TaskList) and command-phase components (Install, Configure, Login, FetchApiKey, Update). Apps and other components import these; they never import apps.
- `src/lib/*.ts` — non-UI logic modules (`auth`, `configure`, `npm`, `paths`, `markdown`, `statistics`, `export`, `upload`, `run`, `restore`, `backend`, `help`, `const`, `reexec`, `analysis-backend`, `proxy`, `doctor`). Components and apps import logic; logic never imports UI.
- `src/providers/*.ts` — agent-specific reader implementations used by `src/lib/export.ts` (one file per agent).

When adding a new command:

1. Add a `src/<Name>App.tsx` for its Ink root.
2. Put any phase-specific Ink components in `src/components/`.
3. Put non-UI logic in `src/lib/<name>.ts` (or a folder if it grows beyond a couple of files).
4. Wire it up in `src/index.tsx`.

## Imports

Use absolute imports with the `@/*` alias. Don't use relative imports.

```ts
// Good
import { InstallApp } from "@/InstallApp.js";
import { Banner } from "@/components/Banner.js";
import { runUpload } from "@/lib/upload.js";

// Bad
import { InstallApp } from "./InstallApp.js";
import { Banner } from "../components/Banner.js";
import { runUpload } from "./lib/upload.js";
```

## Validation

Always run these commands after making changes and ensure they pass:

- `pnpm fix` — lint and format with Biome
- `pnpm typecheck` — type-check with TypeScript
- `pnpm test` — run tests (Vitest)
- `pnpm build && node dist/index.js --version` — bundle the CLI and smoke-test it under Node. The shipped bundle runs under Node (`bin: dist/index.js`); the smoke run catches anything that compiles cleanly but fails at module-link time under Node's ESM loader.

## APIs

- Use `node:fs/promises` (`readFile`, `writeFile`) for async I/O. `node:fs` sync APIs (`readFileSync`, `writeFileSync`, `mkdirSync`, `chmodSync`, etc.) are fine when synchronous behavior is required.
- Use `node:crypto` for hashing (`createHash("sha256")`). Use `node:zlib` for gzip (`gzipSync`).
- Use `node:child_process` (`spawn`, `spawnSync`) or `execa` for shelling out.
- Use built-in `fetch` and `WebSocket` (available in Node 22+).
- **SQLite is built into Node** via `node:sqlite`. It stabilized in Node 23.5; on Node 22.5–23.4 it requires the `--experimental-sqlite` flag. `src/index.tsx` probes for the module at the entry of `case "upload"` and re-execs itself with the flag (via `src/lib/reexec.ts`) when the probe fails, so the rest of the code can `import { DatabaseSync } from "node:sqlite"` unconditionally.

## Testing

Use Vitest (`pnpm test`). The API is close to Jest's:

```ts#index.test.ts
import { test, expect } from "vitest";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For mocks and spies use `vi`: `vi.fn()` to create a mock function, `vi.spyOn(obj, "method")` to spy on an existing one. Use the `MockInstance` type from `vitest` to type-annotate spy variables.

When removing a string, label, or branch, don't pin its absence with `expect(...).not.toContain("removed string")`. The string is no longer anywhere in the source — nothing realistic could put it back — so the assertion only documents history. Update or delete the positive assertion instead. Negative assertions remain legitimate when the string is still emitted by **another branch of the same render**: e.g., a Confirm test that asserts the "no backup yet" arrow does NOT appear when rendering the "backup already exists" branch is pinning a conditional, not a deleted feature.

**Never poll `lastFrame()` for something an app renders just before it exits.** Ink writes an **empty** frame when it unmounts, so `lastFrame()` returns `""` from that moment on. A component that shows its final message and then calls `exit()` — `SkillPushApp`/`SkillPullApp` refusing without raw mode do it after 20ms — leaves a 20ms window that a 20ms poll has to land in; miss it and the predicate can never become true again, so the test burns its whole budget and reports a hang. That was a real full-suite flake (~1 in 8, never reproducible in isolation, and it survived a 10s budget). Use `tests/helpers/raw-mode.tsx#lastNonEmptyFrame(instance.frames)` instead — it is stable once the app is gone. Reproduce the old failure by awaiting a `setTimeout(400)` before the first poll.

Note the whole frame *history* (`frames.join`) is the wrong unit for a negative assertion: a prompt legitimately renders for one frame before the effect that replaces it, so `SkillPullApp`'s `not.toContain("❯ ")` would fail against the history while being exactly right against the settled frame. History is fine for "did this ever appear"; settled frame for "what is the user left looking at".

## Backup behavior

`configureClaudeCode` and `configureOpenCode` always replace the live config (`~/.claude/settings.json`, `~/.config/opencode/opencode.json`), but an existing `*.backup` is never overwritten. On the first run a backup is copied from the live config; every subsequent run skips the backup step and leaves the original `*.backup` in place. There is no prompt and no `overwriteBackups` option — preserving the user's pre-CoDev state is the whole point. `restoreTool` then renames `*.backup` back over the live file.

Claude Code owns **three** files, not one. Beyond `~/.claude/settings.json`, the install flow also touches `~/.claude.json` and `~/.claude/.credentials.json` via two functions in `src/lib/configure.ts`:

- `backupClaudeAuth()` — snapshots both files to `*.backup` (idempotent via `ensureBackup`) and leaves the originals untouched.
- `resetClaudeAuth()` — calls `backupClaudeAuth()` first, then overwrites `~/.claude.json` with `{hasCompletedOnboarding: true}` (so the CLI skips its first-run wizard) and removes `~/.claude/.credentials.json` (so the CLI can't reuse stale session auth that would conflict with the gateway API key in settings.json).

Both run in `SetupApp`'s `finalizing` Phase — silently (no visible Step), best-effort, after the user has clicked through every choice and Configure has succeeded. Which one fires depends on `creds`: any non-Skip path (`new` / `manual` / `existing`) ends up with `creds !== null` and runs `resetClaudeAuth` so the about-to-be-written gateway settings.json takes effect cleanly; the "Skip configuration" path ends up with `creds === null` and runs `backupClaudeAuth` so the user's existing Claude session keeps working. Deferring both halves to finalize means a mid-flow Ctrl-C leaves both files untouched on disk — no backup created, no destructive write. PATH shim install (`installShims`) is deferred to the same Phase for the same reason; the resume message in `SetupComplete` reads `shimsInstalled` to merge the activation hint.

On that same `creds !== null` branch, finalize also calls `disableClaudeCodeLoginPrompt()` (`src/lib/vscode-settings.ts`) whenever a Claude tool — CLI or either extension — was configured: CoDev now owns Claude's gateway auth via `settings.json`, so the Claude Code VS Code extension's interactive login prompt is redundant. It surgically sets `claudeCode.disableLoginPrompt: true` in VS Code's `User/settings.json` (per-platform path honoring `$APPDATA` / `$XDG_CONFIG_HOME`; gated on the VS Code user-data dir existing — absent ⇒ no-op), editing via `jsonc-parser`'s `modify` / `applyEdits` so comments, formatting, and every other setting survive. An already-`true` key is left byte-identical (no write); a malformed or non-object `settings.json` is left untouched. Unlike Claude's own config files this is a single-key edit on a heavily user-owned file, so it is deliberately **not** backed up and **not** part of `codevhub restore` — the additive, idempotent setting is simply left in place. The Skip path (`creds === null`) leaves it alone, since an unconfigured extension still needs its normal login.

The settings.json backup itself is independent and still happens at configure time via `configureClaudeCode` / `backupOnly`, regardless of the Skip choice.

The install flow's "Skip configuration" auth choice routes Configure through `backupOnly(tool)` instead of the per-agent `configure*` functions: it runs the same `ensureBackup` logic for the agent's main config file (so any existing live config is snapshotted to `*.backup` exactly once) and then exits without writing CoDev's own config. `Configure` accepts `creds: Credentials | null`; `null` is the signal to take this backup-only path, and the finalize Phase reads the same `creds === null` signal to pick `backupClaudeAuth` over `resetClaudeAuth`.

`restoreTool` returns `RestoreResult[]` — a length-1 array for single-file tools, length-3 for any Claude tool (settings.json + .claude.json + .credentials.json, in that order). Each file ends in one of four states: `restored` (a `*.backup` existed → swapped over the live file), `deleted` (no backup, and the live file is CoDev-authored → removed, since no backup means nothing preceded it), `kept-live` (no backup, and the live file is *not* CoDev-authored → **left untouched**), or `noop` (neither file exists). Callers iterate. `runRestoreOrKeep` (in `src/lib/remove.ts`) rolls Claude's three results into one aggregated step (`restored 2 files; deleted 1 file (no backup)` style); `runRestore` / `runRestoreAll` (in `src/lib/restore.ts`) print one line per file. In the sweep, `restored` and `deleted` both count as action — an all-`kept-live`/`noop` run exits 1 with "No backups found."

The `deleted` vs `kept-live` split turns on `isCodevAuthored(kind)` in `configure.ts`, and that gate carries the whole safety argument. Restore **consumes** the backup (`renameSync`), so "no backup + live file" is ambiguous: it can mean CoDev wrote the file from scratch, but equally that this is a *second* restore and the live file is the pristine original the first run just reinstated, or that the user hand-wrote a config for a tool CoDev never configured (both `remove` and the bare `restore` sweep visit every tool). Only the first case is ours to delete. `isCodevAuthored` reuses the same per-kind marker detectors `codevhub model` uses (`isCodevClaudeConfig`, `isCodevCodexConfig`, `isCodevOpenCodeConfig`, `isCodevContinueConfig`); each returns `false` for a missing or unparseable file, so anything we can't attribute is kept. The two auth files have no marker key of their own: `claude-json` is matched by whole-file *shape* (`isCodevClaudeJsonStub` — exactly `{hasCompletedOnboarding: true}`, since a real `~/.claude.json` accumulates projects/history/mcpServers), and `claude-credentials` always returns `true` because CoDev never writes that file, only removes it, so a live one can only postdate CoDev. Deliberately no cross-kind inference (e.g. reading settings.json to decide the credentials' fate): `restoreTool` restores `claude-settings` first, which erases that marker, so the answer would depend on iteration order.

`restoreKind`/`restoreTool`/`runRestore`/`runRestoreAll`/`runRemove` all take a trailing `force = false`. `codevhub restore [agent] --force` and `codevhub remove --force` set it, and it **bypasses the authorship gate only**: a backup-less live file is deleted whoever wrote it, so `kept-live` never happens. It deliberately does *not* override the backup branch — a `*.backup` still wins and is still restored, because that file is the user's pre-CoDev original and reinstating it is the whole point of the command. The flag is **intentionally absent from `help.ts`, the README, and all UI copy**; it's an escape hatch, discoverable only from source, and nothing invokes it on the user's behalf. Keep it that way, and keep it long-form only (no `-f` alias) so the reflex `-f` from `upload`/`login` can't unconditionally delete configs by accident. That last rule is **general, not a restore detail**: `-f` is reserved for flags that cost nothing when fired by reflex, so any flag that destroys a user's files stays long-form. `codevhub skill pull --force` follows it for the same reason — it `rm -rf`s the skill directory, which may hold local edits, while `-f` on `login`/`upload`/`doctor` only forces a fresh sign-in. What enforces it there is `parsePullArgs`'s `PULL_FLAGS` allowlist: an unrecognized `-`-prefixed token is an error, so `-f` is rejected loudly rather than silently ignored.

Reporting stays honest under force: `restoreKind` evaluates `isCodevAuthored` even when forcing and sets `RestoreResult.forced = !authored`, so a file taken *despite* not being CoDev's is reported as forced rather than under the default message (which asserts "CoDev wrote it" and would be a false claim about the user's own file). `remove`'s aggregate detail counts them separately (`deleted 2 files (no backup, 1 forced)`), and the NDJSON log carries `forced` on every `restore.kind` document.

Watch the `.map` trap in `restoreTool`: `CLAUDE_RESTORE_KINDS.map(restoreKind)` passes the array **index** into `force`, silently forcing every kind after the first. It must stay `.map((kind) => restoreKind(kind, force))`. `tests/lib/restore.test.ts` pins this ("without force, the Claude bundle keeps all three user files").

When testing the gate, build CoDev-authored fixtures by calling the real writers (`configureClaudeCode` / `configureCodex` / `configureOpenCode` / `configureContinue`) rather than hand-rolling marker keys. A fake fixture that no detector recognizes still lands on `kept-live` and still passes — it just silently stops testing the branch its name claims to cover.

`restoreTool` is invoked via `codevhub restore <agent>` (one tool) or bare `codevhub restore` (sweep all tools). The dispatcher accepts **launch names** — `claude`/`codex`/`opencode`/`codev`/`continue` — and `toolForRestoreAgent` in `src/lib/restore.ts` maps them to the internal `Tool` type. Behavior splits on path: `runRestore` (single) returns 0 for every non-throwing outcome, reporting each file's state; `runRestoreAll` (sweep) errors only when *nothing* changed across every tool. Note `reportRestoreResult`'s switch returns `void`, so a missing `RestoreStatus` case would silently print nothing — the `never` default is what makes the next status addition a compile error.

## Provider identity

`src/lib/provider.ts` owns the provider id and display name CoDev writes into the OpenAI-compatible agent configs (Codex `model_provider` + `[model_providers.<id>]`, OpenCode/CoDev Code `provider.<id>` plus the `"<id>/<model>"` reference, Continue's `CoDev (<name>)` title). Claude Code has no provider concept — it only gets env vars.

Two built-in identities: **aigw / AIGW** for SSO-issued keys (the "Get a new API Key" path, and "Reuse existing API Key" when the saved key carries no provider), and **ai-gateway / AI Gateway** as the manual path's fallback. On "I have my own API Key" the first form field is an optional, ASCII-only **Provider Name**; `providerFromName` slugs it (lowercase, non-alphanumeric runs → `-`, trimmed, capped at 32) and a blank or unusable name falls back to AI Gateway. The slug charset is deliberately `[a-z0-9-]`: TOML bare-key safe so `[model_providers.<id>]` needs no quoting, and slash-free so OpenCode's `"<id>/<model>"` stays parseable.

The load-bearing consequence: the provider id **is** CoDev's authorship marker for codex/opencode/codev-code. It gates `detectConfiguredTools` (whose configs `codevhub model` rewrites), `isCodevAuthored` (restore's delete-vs-`kept-live` decision), and `readAgentConfig`'s base_url readback. Since it's no longer a compile-time constant, `codevProviderIds()` returns the candidate set — the id saved in `~/.codev-hub/auth.json`, then `aigw`, `ai-gateway`, and the pre-rename `netgate` and `aigateway` — and `firstNestedKey` resolves the live entry against it. Nothing writes the pre-rename ids any more; they stay recognized so installs predating the renames keep working, and they converge on the new id at the next config rewrite. Detection is deliberately *saved-id-first*: without auth.json a custom-id config is unattributable and restore keeps it rather than deleting it, matching the module's standing rule that a config we can't attribute is one we don't delete.

`Credentials`/`ApiKeyCreds` carry `providerId`/`providerName` (persisted as `provider_id`/`provider_name`), and `resolveProvider` supplies the AIGW default when they're absent. **`saveApiKey` writes the whole api-key block, so an omitted provider pair clears it** — every re-save site (`ModelApp`'s two re-auth branches and its model switch, `refresh.ts#ensureFreshGatewayKey`, `SetupApp`'s model-choice) must thread it through, or a manually-named provider silently reverts to AIGW on the next model switch or launch-time key refresh. `logout()` is the same hazard by a different route: it rebuilds the surviving file field-by-field rather than deleting SSO keys from it, so anything not listed in its `preserved` object is dropped. The provider pair was missing there and had to be added back — a field added to `AuthFileContents` is not automatically a field that survives sign-out.

## Context windows and auto-compaction

Every agent CoDev configures has to be *told* the window of the model it's talking to. The gateway serves custom models none of them recognize, and each guesses differently when unconfigured: Codex assumes a 272K fallback, OpenCode assumes context `0` (which disables compaction outright), Continue falls back to a generic default. `src/lib/model-limits.ts` is the single source of truth; the four writers in `configure.ts` translate it into each agent's own knob and hold no window constants of their own. The flat `GATEWAY_CONTEXT_WINDOW` / `GATEWAY_COMPACT_*` constants that used to live in `const.ts` are gone — they encoded the assumption that every gateway model shares one 196608-token window, which stopped being true once the gateway served both a 1M-token and a 200K-token model.

`ModelLimits` is `{ context, trigger, output? }`: the true window, the absolute token count where auto-compaction should fire, and an optional output cap. **The table carries windows only** — `limitsFromWindow` derives the trigger as `COMPACT_PCT` (90%) of the window, whatever the window's source, so adding a model means adding one number. `limitsFor(modelId)` resolves **remote → table → `DEFAULT_LIMITS`**, where remote is the gateway's own numbers cached in auth.json and `DEFAULT_LIMITS` (200K/180K) covers anything unrecognized. A model the deployment serves at that same 200K window needs no entry: the default already describes it, and an entry that merely restates the default is one more thing to keep in sync. Model ids in the table are plain strings (#259 dropped the `atob`-encoded `M3_ID`); `FALLBACK_MODEL` in `const.ts` is still encoded and stays that way.

**A table entry has a twin in [codev-code](https://github.com/quickbeard/codev-code) (`packages/codev-gateway/src/model-limits.ts`).** CoDev Code's own gateway sign-in configures itself without going through the hub, so it carries its own copy of the same table. The two are deliberately separate — the hub must keep configuring agents on machines with an older CoDev Code — but a model added to one and not the other gets different windows depending on which flow wrote the config. Add it to both.

Each agent takes a different shape, and the differences are the whole reason this module exists:

- **Claude Code** — `CLAUDE_CODE_AUTO_COMPACT_WINDOW` + `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, via `claudeWindow()` / `claudeCompactPct()`. The one agent that will **not** accept an arbitrary window; see below.
- **Codex** — `model_context_window` + `model_auto_compact_token_limit` (an absolute count). Also single-model, also exact.
- **Continue** — per-model `defaultCompletionOptions.contextLength` / `maxTokens`. Continue has no compaction of its own; it prunes history to fit `contextLength`, so the window is all it needs and there is no trigger to express.
- **OpenCode / CoDev Code** — the hard one, below.

**`limit.input` is what makes OpenCode's trigger per-model, and it is not optional.** The decompiled threshold (identical in both the `opencode` and `codev` binaries) is:

```js
const reserved = cfg.compaction?.reserved ?? Math.min(20000, maxOutputTokens(model));
return model.limit.input
  ? Math.max(0, model.limit.input - reserved)      // reserved IS used
  : Math.max(0, ctx - maxOutputTokens(model));     // reserved is DISCARDED
```

Two consequences. First, **`compaction.reserved` is dead unless `limit.input` is present** — CoDev wrote `{context, output}` for a while and the configured reserve did nothing; the real trigger was `context − maxOutputTokens`, ~36K tokens earlier than intended. Second, `reserved` is a single **top-level** value with no per-model variant in the config schema, so it alone cannot put a 1M model and a 200K model on different triggers: sized for the big one it drives the small one's trigger negative, sized for the small one the big one fires at ~96%.

`declaredInput()` resolves this by solving `input − reserved = trigger`, i.e. `input = trigger + reserved`, per model, against one global reserve. `limit.context` therefore stays the **true** window — the TUI's "% context used" gauge divides by it, so understating it there would misreport every session. The result is clamped to `context`: `trigger + reserved` above the real window would overstate the budget and let a session run past the model's ceiling before compacting, and clamping can only move a trigger earlier, never later.

**Claude Code cannot be told a window larger than 200000, and three separate ceilings enforce it.** All three were read out of the shipped binary (2.1.220); none is documented.

1. `nc()` resolves the window as `Math.min(nativeWindow, envValue)`, so `CLAUDE_CODE_AUTO_COMPACT_WINDOW` can only ever **shrink** it. For a model Claude Code doesn't recognize — every gateway model — `w37()` falls through to `_Z_ = 200000`. A 1M-token model is a 200K-token model to Claude Code, and there is no way around it: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is read only when `DISABLE_COMPACT` is set, which turns compaction off.
2. `Rzq = Math.min(T − round(T × precomputeBufferFraction), qB6(T, opts))` with `precomputeBufferFraction` defaulting to `0.2`, so the trigger is capped at **80% of the effective window**. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` above 80 is inert — the `Math.min` discards it. Hence `CLAUDE_MAX_COMPACT_PCT`.
3. **Pinning a window *below* 200000 disables auto-compaction outright.** Setting the variable makes `nc()` report `source: "env"`, which puts `aiK` on the branch reading `if (window < 200000) return false`. Omitting it leaves `source: "auto"`, which skips that gate and resolves to the same 200000 anyway. So `claudeWindow()` returns `null` below the ceiling and the writer omits the variable — the pre-existing `196608` was tripping exactly this.

The percentage is therefore taken against the **clamped** window, not the model's true one (`800000/1000000` = 80 is a coincidence; `800000/200000` = 400 is what the raw ratio would give), and bounded to `[1, 80]` — Claude Code's own guard is `K > 0 && K <= 100`, so a 0 would be ignored silently.

Net effect: Claude Code compacts at `0.8 × (200000 − min(modelMaxOutput, 20000))`, i.e. **~144–160K regardless of the model**. `S$H` (the model's max output) is not statically resolvable in the binary, so the exact point inside that range is unverified. Claude Code is the one agent where CoDev's per-model windows genuinely cannot take effect — don't "fix" it by raising the numbers.

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is also read into a field named **`testPctOverride`**. It is honored on the production path, but the name says test hook: treat it as unsupported and expect it to disappear.

**Verify OpenCode-family behavior against the shipped binary, not the published schema.** `https://opencode.ai/config.json` documents `reserved` only as "token buffer for compaction" and says nothing about the `limit.input` branch that decides whether it is read at all. The threshold function is greppable in the binary (`grep -aob "cfg.compaction?.reserved"`, then read the surrounding bytes).

The remote source is wired but currently inert: `backend.ts#fetchModelWindows` reads LiteLLM's `/model_group/info` (at the gateway **root**, next to `/key/info`, not under `/v1`) and keeps entries with a numeric `max_input_tokens`. The live gateway reports `null` for every model, so it returns `{}` and the static table carries everything — the moment an admin populates the field, that model becomes gateway-driven with no CoDev release. Unlike `fetchModels`, it **never throws**: a window is an optimization over a sane default, and install must not break because a metadata endpoint 404s on some other gateway build. `ModelSelect` refreshes it fire-and-forget alongside the model list, so it can never delay or fail the picker.

The cache is its **own top-level `model_limits` block** in auth.json with its own `saveModelLimits`/`loadModelLimits`, deliberately *not* a field on the api-key block — see the `saveApiKey` hazard above; a field there would be cleared by every re-save site that didn't thread it through. `limitsFor` memoizes the read once per process (configure* runs once per selected agent and once per model in the OpenCode map), so tests that write the cache must call `resetModelLimitsCache()`.

One test-hygiene note: `ModelSelect` now fetches on mount, so **every test that renders it must stub `fetchModelWindows`**. Left unmocked, the `baseUrl` cases issue real HTTPS requests, and a non-empty result writes to the developer's actual `~/.codev-hub/auth.json` — `tests/components/ModelSelect.test.tsx` stubs neither `$HOME` nor the network on its own.

## Config refresh and upload self-healing

Analysis backend coordinates and the public gateway base URL (`gateway_url`) are not baked into the source — they're fetched together from the backend's `POST /config` endpoint and cached in `~/.codev-hub/auth.json`. `gateway_url` is read back via `AI_GATEWAY_URL()` / `AI_GATEWAY_OPENAI_URL()` in `src/lib/const.ts` (the latter derives the `<base>/v1` endpoint), which `configure.ts` and `backend.ts` fall back to whenever a flow has no explicit `baseUrl` (the SSO-key path). Like the analysis backend accessors (`ANALYSIS_BACKEND_URL()` / `ANALYSIS_BACKEND_ANON_KEY()`) they hard-fail with a "run `codevhub install`" message if the cache was never populated. Two invariants keep that cache fresh:

1. **Every command that consumes analysis backend coords refreshes config after a successful login.** `login()` itself does not call `refreshCodevConfig` — callers run it explicitly so the timing fits each flow. Today:
   - `InstallApp` awaits `refreshCodevConfig` inline between the install and key-choice steps. The `refreshing-config` Phase still exists as an internal state to block forward progress, but renders no visible Step.
   - `src/lib/upload.ts`'s `ensureAuth` calls `refreshCodevConfig` on the fresh-login branch (so the first analysis backend attempt doesn't have to fail and retry just to populate the cache).
   - Tests that exercise real `login()` must mock `POST /codev-backend/config` if (and only if) the caller also calls `refreshCodevConfig`.
2. **`runUpload` retries once on a "refreshable" error.** `isRefreshableError` (in `src/lib/upload.ts`) is deliberately narrow: `Missing supabase_…` from the cache accessors, or HTTP `401`/`403` from any analysis backend or CoDev backend fetch. `5xx`, `404`, network errors, and timeouts are NOT retried — refreshing won't help and we'd amplify the outage. Per-file upload errors stay in `summary.errors` and don't trigger the pipeline-level retry. If you change `runAnalysisBackendUpload`'s shape, keep that boundary intact.

**The vendor name survives only on the wire.** The service is called the *analysis backend* in every comment, doc, identifier and user-visible string. Three things keep their historical `supabase` spelling because they are contracts CoDev doesn't own: the on-disk / `POST /config` keys `supabase_url` / `supabase_anon_key` (and the response's `supabaseUrl` / `supabaseAnonKey`, mapped onto `CodevConfig`'s `analysisBackendUrl` / `analysisBackendAnonKey` at the parse boundary in `backend.ts`), the backend route `POST /supabase/exchange`, and the `Missing supabase_…` text those accessors throw — which is exactly what `isRefreshableError` matches on. Renaming any of them silently stops parsing a live response, hits a 404, or breaks the retry trigger.

## TLS trust (corporate proxies)

Node verifies TLS against its **own bundled Mozilla CA snapshot and never consults the OS trust store** ([tls.rootCertificates](https://nodejs.org/api/tls.html#tlsrootcertificates): "fixed at release time… identical on all supported platforms"). Users behind a TLS-intercepting proxy (Zscaler/Netskope/Fortinet) or HTTPS-scanning AV get every chain re-signed by a corporate root that MDM/GPO installed into the *OS* store — so their browser works and we fail with `fetch failed (self-signed certificate in certificate chain)`.

`src/lib/tls.ts#applySystemCaCertsOnce` fixes this with no user configuration: `tls.getCACertificates("system")` reads the OS store **even without the `--use-system-ca` flag**, so we merge it into the default set. Details that are load-bearing:

- **Merge on failure, never speculatively.** `loggedFetch` runs the request; only if it fails with a cert error does it merge and retry once (`fetchTrustingSystemCa`). The OS-store read is **synchronous** and costs ~20ms on macOS but ~300ms+ on Windows, where it blocks the event loop — an earlier revision merged before the first request and slowed the whole Windows suite by 50–200%, stalling Ink's render timers badly enough to fail three timing-sensitive tests (including `TaskList`, which never fetches). A cert error is a precise signal that the user is one of the affected minority, so paying only then keeps the happy path at exactly zero cost. `tests/lib/log.test.ts` pins that a successful request never touches the store.
- **At most one retry per process.** `applySystemCaCertsOnce` returns null once it has run, so a chain that stays untrusted surfaces its error instead of looping. Replay is safe: a TLS handshake fails before any body is sent, and every call site passes a replayable body (string/URLSearchParams/FormData/Buffer), never a stream — keep it that way.
- **Merge `default` + `system`, never `bundled` + `system`.** `"default"` already folds in `NODE_EXTRA_CA_CERTS`; narrowing it would silently drop the certs of users who fixed this the documented way.
- **Every failure mode is a no-op**, including an empty system store (`setDefaultCACertificates` is then never called, keeping Node's behavior byte-identical). Trust config isn't ours to have opinions about, and a bad merge would break users whose certs already work.
- The APIs need Node ≥22.19/24.5, hence `tlsApi.supported()`. Our floor is 22.21, so every supported 22.x is fine — but **24.0–24.4 is not**, which is what keeps the guard load-bearing. They're accessed off the default import, never destructured — a named ESM import of a builtin export that doesn't exist is a link-time error on older Node.

`describeNetworkError` unwraps Node's bare `fetch failed` (the real reason hides on `err.cause`) and appends a remedy for cert codes. It exists because **Node's own `--use-system-ca` hint pointedly excludes `SELF_SIGNED_CERT_IN_CHAIN`** — `crypto_common.cc` gates it on `DEPTH_ZERO_SELF_SIGNED_CERT` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `UNABLE_TO_GET_ISSUER_CERT` only, so the corporate-proxy case, the one the hint most exists for, is the one that prints nothing. If a cert error survives the merge, the root isn't in the OS store either, so the hint names `NODE_EXTRA_CA_CERTS` rather than `--use-system-ca`, which would be a dead end. Keep `certHint` **pure** — reading the OS store to word a sentence would put that same Windows stall on the error path, and the retry has already read it.

Note the blast radius: this only covers **our own** process. `npm i -g` during install and the agents themselves are separate processes behind the same proxy and need `NODE_EXTRA_CA_CERTS` / npm's `cafile` of their own.

## HTTP proxies

TLS trust (above) and proxying are **separate problems** with separate fixes; a machine behind a corporate gateway usually has both.

Node does not honor `HTTP_PROXY`/`HTTPS_PROXY` on its own. Support is gated behind `NODE_USE_ENV_PROXY=1` and read at **bootstrap**, so assigning `process.env` mid-run is too late for the already-initialized global dispatcher. Users who follow the install guide and export only the proxy variables therefore get no proxy at all — silently, with no warning from Node — and every `fetch` dies in the firewall.

`src/lib/proxy.ts#applyEnvProxy` closes that gap once, from `index.tsx` right after `initLogging` and before dispatch, so `install`, `login`, `upload`, `model` and the launch-time key refresh all benefit rather than just the command being debugged. It no-ops unless a proxy is set and `NODE_USE_ENV_PROXY` is unset, then takes one of two paths:

1. **`http.setGlobalProxyFromEnv()`** when the running Node has it. Verified empirically to route global `fetch`, not just `node:http`/`https` Agent traffic — which is what makes the fast path viable at all. Probed behind the `httpApi` indirection, same shape as `tlsApi` (off the default import, never destructured).
2. **Re-exec** with `NODE_USE_ENV_PROXY=1` otherwise, via `reexec.ts#spawner`, guarded by a `CODEV_PROXY_APPLIED=1` sentinel so it can never loop.

`readEither` normalizes each spelling **independently** (`nonEmpty(env.HTTP_PROXY) ?? nonEmpty(env.http_proxy)`). A plain `??` only falls through on `undefined`, so an exported-but-empty `HTTP_PROXY` would mask a perfectly good lowercase one — `tests/lib/proxy.test.ts` pins this.

`NO_PROXY` is the other half. An entry covering our own backend (internal images ship a blanket `*.viettel.vn`) routes sign-in traffic *around* the proxy and straight into the firewall — the documented cause of `Login failed`. `matchingNoProxyEntry` detects it. The split in responsibility is deliberate: **`index.tsx` only warns** (rewriting the user's environment mid-command is overreach), while **`doctor` strips it in its retry child**, where the user has explicitly asked us to try a proxy.

Blast radius again: **npm keeps its own proxy and TLS configuration** (`npm config set proxy` / `https-proxy` / `cafile` / `registry`), entirely separate from these variables. A working `codevhub` proves nothing about `npm i -g`, which is why `doctor` checks them separately.

## `codevhub doctor`

Pre-flight for everything `install` depends on, so users on a locked-down network find out *before* `npm i -g` mutates their machine. Read-only apart from the diagnostic log — it never installs or configures anything.

`src/lib/doctor.ts` holds a `Check[]` registry in five groups (`environment`, `network`, `account`, `llm`, `state`), each `run` returning `pass`/`warn`/`fail`/`skip` and never throwing. `DoctorApp` walks the groups; `components/CheckList.tsx` renders them. `Login` is mounted for the sign-in check so `doctor` exercises the real flow, including the paste-back fallback.

**The diagnosis layer is the point of the command**, not a detail. `lib/tls.ts#describeNetworkError` unwraps one level of `err.cause` and only special-cases cert codes; everything else still reaches the user as `fetch failed (connect ECONNREFUSED 10.0.0.1:8080)`, which tells a non-engineer nothing. `diagnoseError` walks the **whole** chain (including `AggregateError`, which Node emits one entry per address family into) and returns four parts — what happened in plain language, the likely cause *given this machine's proxy state*, the fix, and the raw chain verbatim. Load-bearing details:

- **A configured-but-ignored proxy supersedes every other explanation** and takes the `fix` slot, because nothing else can be diagnosed until it is fixed.
- **`rootLink` recovers a code from the message text** when `.code` was lost to a re-throw (`"getaddrinfo ENOTFOUND host"`), which is the difference between a real diagnosis and the generic fallback.
- **`AbortSignal.timeout` is special-cased** — its own message names neither host nor duration, so both are rebuilt from the `Attempt`.
- **HTTP responses are diagnosed too** (`diagnoseResponse`). A non-2xx is not an exception, so `describeNetworkError` never sees it — yet 407 and a proxy-issued 403 are exactly what internal users hit. Interceptor headers (`via`, `proxy-authenticate`, …) distinguish "the network blocked this" from "your account lacks access".
- **npm's stderr is reproduced in full** (`diagnoseExec`) — it names the registry, proxy and `.npmrc` in play, and truncating it destroys the diagnosis.
- **Nothing bypasses redaction.** Raw chains and response bodies go through `extra`, never `unsafeUnredacted`, and terminal output is scrubbed via `log.ts#redactSecrets` (the same `SCRUB_PATTERNS`) because users paste this into chats.

`Login`/`FetchApiKey` render `describeFailure`, which upgrades **transport** errors (those with an `err.cause`) to the compact diagnosis while leaving a backend's own precise HTTP message alone — proxy-oriented reasoning about `Backend /config failed (403)` would be actively misleading. Single-line reasons stay inline (`Login failed: <reason>`); only a multi-line diagnosis breaks onto its own lines. `Login` also takes an optional `onError`, which hands failure to the parent and drops its retry prompt — `doctor` records login as one check among many and must reach its summary.

**The re-exec handoff.** When the network group fails, `DoctorApp` offers a proxy prompt and, on submit, records `doctorOutcome.retryWithProxy` and exits — `index.tsx` calls `rerunDoctorWithProxy` after `waitUntilExit()` resolves. It **cannot** happen inside the component: `spawnSync` with inherited stdio while Ink still owns the TTY corrupts the terminal. `CODEV_DOCTOR_PROXY=1` on the child stops the prompt being offered twice, and is the *only* guard on it.

**The report file.** Every run writes `~/.codev-hub/doctor-report.json` (`paths.ts#doctorReportPath`) and **replaces** the previous one — it is a snapshot of "how is this machine right now", and a stale one is worse than none when it is attached to a ticket. It carries the timestamp, CoDev/Node/platform versions, the full proxy environment, per-check outcomes including diagnoses, the summary counts and the next steps. Writing is best-effort in the same sense as `lib/log.ts`: a diagnostic that breaks the command it is diagnosing is worse than no diagnostic, so a failure returns null and the run continues. The serialized JSON goes through `redactSecrets` before hitting disk — this is the file most likely to be emailed around, so it is the last place a token should survive. Note this is *distinct* from the NDJSON diagnostic log, which also receives every check as a `doctor.check` document; the report is one self-contained artifact, the log is the append-only trail.

**The environment is reported as it actually is.** `proxy-env` renders `proxy.ts#proxyEnvSummary`: the seven core variables **always, set or not** — `unset` is an answer, since most of the failures this command exists for are a *missing* variable and a reader scanning for `HTTP_PROXY` should find it stated rather than infer its absence — plus anything else the user has set, verbatim and in their own spelling, including variables `readProxyEnv` does not model (`NODE_EXTRA_CA_CERTS`, `NODE_OPTIONS`, npm's `npm_config_*`). The lowercase spellings and `npm_config_*` are in the when-set tier only: listing eleven more `unset` entries would bury the seven that matter, and `http_proxy: unset` beside `HTTP_PROXY: unset` reads as a duplicate. `readProxyEnv` normalizes to fixed fields, which is what the logic needs but hides everything else, and on a misbehaving machine the variable nobody thought to look at is usually the culprit. Each request's activity line also names the proxy it went through (`proxyForUrl`), which accounts for scheme and NO_PROXY — the only place a NO_PROXY exemption becomes visible as one request quietly going direct while the rest are proxied. **Credentials are masked at every display boundary** (`maskProxyCredentials`): proxy URLs routinely carry `user:pass`, and the check row, the activity lines and the report file all end up pasted into tickets. `readProxyEnv` keeps the real value — the retry child has to authenticate.

**Everything doctor does is shown under the check that did it.** Subprocesses go through an opt-in recorder in `execAsync` (`npm.ts#commandLog`); HTTP requests go through its sibling in `loggedFetch` (`log.ts#requestLog`). `doctor` switches both on, and `runChecks` slices whatever the recorders gained while each check ran onto that check's `activity` — exact because checks run strictly in sequence, and it still works for a check that fans out internally (npm-registry runs five `npm config get` concurrently; all five land on its row). Sign-in is the exception, since `<Login>` owns it rather than `runChecks`, so `DoctorApp` marks it by hand with `activityMark`/`collectActivity`. Activity lines carry **no status icon**: the row's icon is the verdict, and an earlier revision that listed requests separately with their own icons scored an expected 401 red directly under a check that correctly called it a pass. They render **after** the fix — status, what, what to do, then evidence — because putting them above pushed the one actionable line down the screen. Recorded URLs drop the query string (OAuth codes, signed-URL signatures). Each recorder lives *inside* its seam rather than wrapping it, because helpers reach those functions through module-local bindings (`npm.ts`'s `npmGlobalRoot`, `verifyInstall`, … call `execAsync` directly) that no external wrapper can intercept — and both stay off by default so `update` and the upload daemon don't accumulate unbounded buffers.

**And again, run-wide, in an `Activity` step.** `components/ActivityLog.tsx` renders **Commands run** and **Endpoints contacted** from the snapshots `DoctorApp` takes at the terminal phase (the recorders are mutable buffers, so reading them during render would tear); the report file carries the same two lists under `commands` and `requests`. This is not redundant with the per-check lines: those answer "why did *this* check fail?", these answer "what did you just run on my machine?" and "which hosts do I allow-list?". The npm list alone was only half the answer — the connection tests to the backend, the analysis backend and the gateway never touch `execAsync`, and on a corporate network the endpoints are the *more* useful half. An empty section is omitted rather than printed as a bare header. The endpoints section scores on **reachability, not 2xx**: a 401 means the endpoint answered, and scoring it on `ok` painted expected 401s red while the check rows above correctly called them a pass. The step sits **above** the `Result` step — the reverse of the within-row order, and for the same reason: at run level what must survive on screen is the verdict, the numbered next steps and the report path, and a ten-line inventory printed after them scrolls them away.

**Every child process is inventoried.** `tests/lib/doctor-commands.test.ts` asserts the complete, ordered list of commands each group spawns — 10 for a full run, all `npm`, none mutating — so a new subprocess shows up in review rather than quietly appearing on users' machines. It spies at the **`execFile` boundary**, not on `npm.ts#execAsync`: helpers inside npm.ts call `execAsync` through their module-local binding, which a spy on the export cannot intercept. An earlier draft used that spy and reported the `state` group as spawning nothing while it was in fact shelling out four times. That same measurement is what caught `installedAgentsCheck` running `npm root -g` once per agent; it now resolves the root once.

The spawn itself lives in `lib/doctor.ts`, not the dispatcher, so the exact command is assertable — `tests/lib/doctor.test.ts` spells it out rather than describing it. It runs `node [...process.execArgv] <process.argv[1]> doctor [...args]` with `stdio: "inherit"`: node directly on the script, never a shell and never the `codevhub` bin. Forwarding `execArgv` is load-bearing — a `pnpm dev` run carries tsx's loader flags, and a child without them cannot load TypeScript and dies immediately.

The prompt is offered **whether or not a proxy is already configured**. An earlier revision suppressed it when one was active, reasoning that "it's set up, so something else is wrong" — that was backwards: a wrong proxy address is among the likeliest reasons the checks failed, and suppressing the prompt left exactly that user with no way to try another. When a proxy is present the copy shifts from "do you need a proxy?" to "is this one wrong?", naming the current value, and Enter keeps it rather than skipping.

The `terminal` check reports whether this terminal can supply keystrokes at all (see the next section). It is the one check whose failure the dispatcher acts on *before* `doctor` is ever reachable, and the reason `doctor` itself is exempt from that refusal.

**`PREFLIGHT_CHECKS` vs `ENVIRONMENT_CHECKS`.** `SetupApp` runs the former at the head of install/config. It is strictly pure — `process.versions` and `process.env` only. The npm checks are excluded because each spawns `npm config get` (~300ms) and install runs npm for real moments later anyway; `system-ca` is excluded because the OS-store read blocks the event loop for 300ms+ on Windows, which is precisely the stall documented in the TLS section above. The pre-flight is **advisory and never blocks** — the one condition that genuinely cannot proceed (Node below the floor) is already refused at startup in `index.tsx`.

## Interactive terminals (Git Bash)

Ink drives every prompt through raw mode, and its whole definition of "supported" is one property: `isRawModeSupported = stdin.isTTY` (`ink/build/components/App.js`). When a component calls `useInput` and that is falsy, Ink **throws from a mount effect** — which reached the user as a React stack across a 2.4 MB bundle, naming no cause and no fix.

The way to land there on Windows is **Git Bash**: MSYS2/mintty pipes stdin through its own pty emulation rather than a Win32 console, so Node sees a pipe and sets no `isTTY` — raw mode is unavailable even though a human is plainly typing. `src/lib/tty.ts` owns the detection and the wording; `rawModeSupported()` deliberately mirrors Ink's gate exactly so the two cannot drift. `stdinKind` classifies the failure as `msys` / `ci` / `redirected`, and **CI is tested before MSYS** — a Windows runner using Git Bash is non-interactive by design, and telling a pipeline to open Windows Terminal is nonsense advice.

**The dispatcher refuses, it does not degrade.** `index.tsx#requireInteractiveTerminal` prints `interactiveTerminalBlocker`'s what/cause/fix and exits 1 before `render()`. Only commands that mount an input component *unconditionally* are gated — `install`, `config`, `model`, `remove` without `--yes`, and `login --admin` without both credentials. Everything else is deliberately left alone because it works in Git Bash today and must keep working: `update` and `logs` take no input, `upload` needs it only for a fresh login's paste-back, plain SSO `login` completes through the browser and the loopback callback, and `skill pull`/`push` already fall back to their non-interactive runners on `isTTY`. Gating those would be a regression dressed as a fix.

**`doctor` is exempt on purpose** — in that terminal it is the only command left that can explain the problem, so it must survive without a keyboard. Two things make that true: `DoctorApp` skips the `proxy-prompt` phase (a text field, and mounting it would take the run down), and `<Login>` gates its own `useInput`. Sign-in itself still runs — the browser and loopback callback need no keystrokes — so account and LLM coverage is preserved rather than skipped; only the paste-back fallback and the Enter-to-retry affordance are replaced with a line saying why.

**Components must ask Ink, not the process.** `components/useCanType.ts` reads `useStdin().isRawModeSupported`, which is the exact value Ink gates on and stays correct when the stream is not the process's own — `ink-testing-library` supplies its own stdin with `isTTY: true`, so a component reading `process.stdin` would render degraded in every test. `lib/tty.ts#rawModeSupported()` is for the dispatcher and the `terminal` check, which have no React context.

**The `Boolean` in `useCanType` is load-bearing.** Node leaves `isTTY` **undefined** on a pipe rather than setting it false, while `useInput` skips raw mode only on `options.isActive === false` — a strict comparison. Forwarding the raw `undefined` reads as "active" and throws the very error the gate exists to prevent. No unit test can catch it, since `ink-testing-library`'s fake stdin sets a real boolean; it was found by running the built CLI with `< /dev/null`, which is the only way to reproduce it. `tests/lib/tty.test.ts` pins `toBe(false)` rather than falsiness for that reason. **Do the same for any new prompt: gate on `useCanType()`, and smoke-test it with piped stdin, not only under vitest.**

**Testing the no-raw-mode path goes through `tests/helpers/raw-mode.tsx#renderWithoutRawMode`.** `ink-testing-library`'s stdin always reports `isTTY: true` and its `render` takes no options, so the flag has to be flipped on the instance and the tree re-rendered — Ink recomputes `isRawModeSupported` every render. The helper renders an **inert tree first** so the flag is already false when the component under test mounts. Four tests used to mount the real component and flip the flag underneath it, which is a state no real terminal reaches: `useInput`'s effect calls `setRawMode(true)` while raw mode still looks available, and `handleSetRawMode` (ink's `components/App.js`) **throws** whenever it runs with `isRawModeSupported` false — including from the cleanup, whose `setRawMode` identity changes at exactly the moment the flag flips. Mounting in the target state sidesteps the whole window and is what the tests claim to be doing anyway.

## Diagnostic logging

`~/.codev-hub` has two log homes — don't mix them up:

- `~/.codev-hub/agent-logs/<project>/` — **conversation exports** (the data `codevhub upload` ships). `paths.ts#agentLogsDir` / `projectLogsDir`. Used to live at `~/.codev-hub/logs/`; `runExport` still migrates legacy project folders over (directories only).
- `~/.codev-hub/logs/codev-YYYYMMDD.ndjson` — **the CLI's own diagnostics** (`paths.ts#cliLogsDir`, written by `src/lib/log.ts`). One ECS NDJSON document per line.

`lib/log.ts` ground rules, in priority order: (1) logging can never break or block a command — every disk touch is wrapped, failed init degrades to no-op; (2) no secrets on disk — key-based redaction of structured fields plus pattern scrubbing of the serialized line (bearer values, JWTs, `sk-…` keys, sensitive query params); URLs persist as domain + path only. The one deliberate exception: the configured gateway API key, which `logApiKeyConfigured` writes verbatim via the `unsafeUnredacted` escape hatch — its only sanctioned use — during `codevhub install`/`config` (event `configure.api-key`, carried in `codev.api_key`, never the message); everything else stays redacted; (3) never write to stdout/stderr — Ink owns the TTY. Files are date-named (no rename rotation: the foreground CLI and the detached upload daemon append concurrently); retention prunes at init (14 days / 50 MB) and only touches the `codev-*.ndjson` pattern. Env knobs: `CODEV_LOG_LEVEL` (default `debug`, `silent` disables), `CODEV_LOG_DIR`.

`initLogging(command, argv)` runs in `index.tsx` before dispatch: every command gets `command.start`/`command.end` (sync exit hook) and crash capture (`uncaughtException`/`unhandledRejection` — handlers replicate Node's print-and-exit-1). Each process has a `trace.id`; `CODEV_TRACE_PARENT` carries the parent's id across the sqlite re-exec and the upload-daemon spawn (`codev.parent_trace_id`).

Instrumented seams — extend these rather than adding ad-hoc writes: `loggedFetch(endpoint, url, init)` wraps every direct fetch (start + completion docs; error bodies read from a `Response.clone()` so callers' streams stay intact; request headers/bodies never serialized); `npm.ts#execAsync` covers all shelled-out children (npm, `code`, JetBrains CLIs, codegraph) with exit code + stderr tail; `runAgent` logs agent launches with an **args count only** — agent args can carry prompt text and must never reach disk; `login()` and `runUpload` tee their status callbacks. Keep `event.action` to the taxonomy listed in `LogFields`.

Daemon specifics: `runUploadDaemon` logs `daemon.skip` / `daemon.run` documents to the NDJSON log; the detached child's own stdout/stderr are discarded (`stdio: ["ignore", "ignore", "ignore"]` in `spawnUploadDaemon`) — there is no separate `upload.log` sink, since the child runs through `index.tsx` and its diagnostics already land in the NDJSON log. `~/.codev-hub/last-upload.json` is status, not logging, and stays.

The reader side is `src/lib/logs.ts` (`codevhub logs`): bare mode prints the most recent run, excluding this very invocation's trace and prior `logs` runs; `--trace <id>` accepts a prefix; child runs are linked via `codev.parent_trace_id`. Plain console output, no Ink.

Testing: logging is a silent no-op until `initLogging` runs, so ordinary tests need no setup and never write files. Tests that assert documents stub `CODEV_LOG_DIR`, call `initLogging(cmd, [], { installProcessHooks: false })` (so vitest's process stays free of our exit/crash listeners), and `resetLogging()` in `afterEach`. Related: `login()`'s force-login probe is keyed off `~/.codev-hub/auth.json` — not the `~/.codev-hub` dir — precisely because the logger creates `~/.codev-hub/logs` at the entry of every command.

## Where skills go (`codevhub skill pull`)

`src/lib/skill-dirs.ts` owns the one fact this feature turns on: **which directory each agent reads.** Establish it from the agents' own source, never from their docs — the table baked into the CoDev Code bundle lists only the `~/…` paths and omits the project-scope walk, which is the opposite of what the code does.

The authority is `packages/opencode/src/skill/index.ts#discoverSkills` (CoDev Code / OpenCode — same module): `externalDirs = [".claude", ".agents"]`, scanned under `global.home` **and** walked from cwd up to the worktree root. Codex reads `.agents/skills` at both scopes (and `$HOME`); Claude Code reads `.claude/skills` at both. So:

| | `.agents/skills` | `.claude/skills` |
|---|---|---|
| Codex | yes | no |
| CoDev Code / OpenCode | yes | yes |
| Claude Code | no | yes |

Neither directory alone covers all four; together they do, with the **same rule at both scopes** — scope only chooses the root (`process.cwd()` vs `homedir()`). No agent needs a directory of its own, and in particular there is no `.codev/skills` or `.opencode/skills` link to write.

`resolveTargets` therefore extracts **once** into whichever directory covers the most selected agents and links the other only if some selected agent can't reach it. When Codex isn't selected, `.claude/skills` alone serves everyone and only one directory is created. Adding Codex is what forces the second into existence. A hub skill can run to thousands of files (one is ~11k), so fanning out a copy per agent is not free.

**Links are relative symlinks.** This repo's own skill is wired exactly that way — `.claude/skills/vercel-react-best-practices -> ../../.agents/skills/vercel-react-best-practices`, committed as git mode 120000 — and relative is what survives `git clone`; an absolute link breaks in every other checkout. `linkOrCopy` degrades in order: relative symlink → Windows **junction** (absolute, but needs neither Developer Mode nor admin, unlike a Windows symlink) → recursive copy. The mode is reported verbatim in `InstallResult.placements`, so a fallback copy is never described as a link.

**Claude Code follows a symlinked skill directory only from v2.1.203.** Below that the link reads as a file with no SKILL.md and the skill is simply invisible, so `claudeFollowsSymlinks()` probes `claude --version` and forces a copy for that one link. Tests must stub `npm.execAsync` or they depend on whatever Claude Code the machine happens to have.

**The duplicate-name warning is expected, not a bug.** When both directories exist, CoDev Code and OpenCode scan both, reach the same skill twice, and log `duplicate skill name` (`index.ts:125`); the last scan wins and the skill resolves to a single entry. It is log-only — warnings are not published as session events, unlike the parse errors just above them — and it already happens for any user whose skill sits in both directories, independent of CoDev. Users have `CODEV_DISABLE_CLAUDE_CODE_SKILLS` / `CODEV_DISABLE_EXTERNAL_SKILLS` (`packages/opencode/src/effect/runtime-flags.ts`); **CoDev must not set those on their behalf.**

**Verifying against CoDev Code: query `/skill`, not `/api/skill`.** They are two different services. `/api/skill` is v2 (`packages/core/src/skill.ts` + `config/plugin/skill.ts`), which registers only `<configdir>/skill{,s}` plus `skills.paths` and so reports **nothing** from `.claude`/`.agents` — querying it will look exactly like a broken install. `/skill` is v1, the service `session/system.ts` uses to build the actual prompt. If CoDev Code ever migrates the prompt to v2, `.agents/skills` will need a `skills.paths` entry and this design changes.

CoDev Code is the flagship: `ALWAYS_AGENT` is in every target set, the picker renders it locked, and `--agent` folds it in whether or not it was named.

## CodeGraph integration

`src/lib/codegraph.ts` integrates the external [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph) tool (a CLI + MCP server). Two surfaces:

1. **Install wiring.** Tools map to CodeGraph's *built-in* `--target` ids via `toolToCodegraphTarget` (the three CLI agents, plus both Claude Code *extension* variants → `claude`; Continue → none; `codev-code` → null, see below). The work is split in two:
   - **Install** (`ensureCodegraphInstalled` = `npm i -g @colbymchenry/codegraph`, always) runs *before* finalize, as a visible row in the `Install` `TaskList` (labeled with the npm package name, like the agent rows) (`src/components/Install.tsx`, keyed `CODEGRAPH_TASK_KEY`). In **install mode** it sits alongside the agent rows (parallel install). In **config mode** the agents are already installed, so `Install` is rendered with `includeAgents={false}` — a CodeGraph-only step titled "Installing CodeGraph", shown right after login (only when `codegraphEligible(tools)`; otherwise config skips straight to the post-login side-effects / key-choice). The `CODEGRAPH_TASK_KEY` sentinel is **not** a `Tool` — in install mode `handleInstallDone` splits it out of the survivor set (Configure/shims would choke on it) and excludes it from the all-failed fail-stop; in config mode the survivor set is just `tools` (the CodeGraph row is best-effort and never gates the agents).
   - **MCP wiring** (`setupCodegraph` → `runCodegraphInstall` = `codegraph install --target <csv> --location global --yes`) runs in `runFinalizeSideEffects`. `setupCodegraph` assumes CodeGraph is already installed — it only wires.

   The whole thing is **best-effort**: the install row soft-fails as a yellow ▲ (never a ✗, never affects the fail-stop), and a wiring failure becomes a `warning` result rendered as a ▲ row — neither aborts the CoDev flow. An empty-eligibility selection returns `skipped` and renders nothing. CodeGraph's own `--yes` install skips putting itself on PATH, which is why CoDev installs the package itself (the MCP configs reference a bare `codegraph` command that must resolve at agent-launch time).

   **CoDev Code wiring is special.** codegraph has no built-in target for the fork, so `setupCodegraph` wires it per run via one of two paths that produce byte-identical config (the `mcp.codegraph` entry in `codevCodeConfigPath()`, i.e. `~/.config/codev/codev.json(c)`): **Path A** — when `supportsCustomTargets()` (probe: `codegraph targets list`, read-only; the capability is codegraph PR #1459) reports support, register `CODEV_TARGET_SPEC` via `codegraph targets add` and append `codev` to the one install CSV; **Path B** — otherwise `wireCodevCodeMcp()` edits the config directly (surgical jsonc-parser `modify`/`applyEdits`; idempotent — an already-correct entry writes nothing; refuses malformed files). A registration failure on a capable binary silently falls back to the shim. Because codev-hub npm-installs the latest codegraph right before wiring, Path A activates machine-by-machine the moment upstream releases custom targets — once the released floor supports them, delete Path B and the probe (pure code removal, no migration). Gating uses `codegraphEligible(tools)` (built-in targets **or** codev-code), never `codegraphTargets(...).length` — codev-code is the always-on flagship tool, and gating on targets alone would write an MCP entry referencing a binary that was never installed.

   **Config-rewrite preservation.** `configureOpenCodeKind` (OpenCode + the fork) whole-file-replaces its config, and runs not just at install time but on every gateway-key auto-refresh (`refresh.ts#ensureFreshGatewayKey`) and `codevhub model` switch. It therefore carries the existing top-level `mcp` map (via `readPreservedMcp` — best-effort, only object-valued maps) across the rewrite; without that, every refresh would silently unwire CodeGraph (either path) and any MCP servers the user added. The `mcp` entry never lands in `*.backup` (taken before CoDev's first write), so restore still returns the true pre-CoDev state.

2. **Command passthrough.** `codevhub codegraph <args>` forwards verbatim to `codegraph <args>` via `forwardToCodegraph` (e.g. `codevhub codegraph init -y`). It mirrors `src/lib/run.ts#runAgent` (inherited stdio, SIGINT/SIGTERM swallowing, win32 `shell:true`) minus the shim-dir stripping and upload daemon — CodeGraph isn't a chat agent and isn't shimmed. ENOENT prints an install hint.

3. **Removal.** `codevhub remove` (`src/lib/remove.ts#runRemove`) runs `runCodegraphUninstall` (`codegraph uninstall --location global --yes`) before the config restores, to revert CodeGraph's MCP wiring across agents, then sweeps CoDev Code's `mcp.codegraph` entry directly via `unwireCodevCodeMcp()` (an older codegraph doesn't know the custom target, and the entry may be shim-written; the sweep no-ops when a custom-target-aware uninstall already removed it, and drops an emptied `mcp` wrapper). It does NOT npm-uninstall the codegraph package (matching how remove leaves the codev-ai package). It's best-effort via a new `"warning"` `StepStatus`: if the codegraph package was already removed the command errors (ENOENT), and the step is a ▲ warning that's excluded from `anyFailed` — so the remove still succeeds. `RemoveApp` renders warning steps in both the success and failure views.

Spawn/exec are routed through stubbable indirections for tests: `codegraphRunner.spawn` (passthrough) and `lib/npm.ts#execAsync` (install). The Install/Config integration tests spy on both `ensureCodegraphInstalled` and `setupCodegraph` so neither the Install step nor finalize shells out.
