# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Before editing code

**When working in `codev-cli/`, read `codev-cli/CLAUDE.md` first and follow its conventions.** It is authoritative for CLI-specific rules (Bun-first APIs such as `Bun.serve` / `bun:sqlite`, absolute imports via `@/*`, and the validation chain `bun run fix` + `bun run typecheck` + `bun test` + `bun run build`). The root file below only covers cross-cutting monorepo concerns.

## Monorepo layout

Two independent Bun packages in a single git repo:

- `codev-cli/` — interactive Ink + React CLI. Owns the full OIDC/PKCE login flow with Viettel SSO. Has its own `CLAUDE.md` with CLI-specific conventions (Bun APIs, absolute imports via `@/*`, validation commands) — **read it when working in `codev-cli/`.**
- `codev-proxy/` — Bun HTTP server. Verifies an SSO access token and exchanges it for a LiteLLM API key via a gateway endpoint.

Each package has its own `package.json`, `bun.lock`, `biome.json`, `tsconfig.json`, and `Dockerfile`. There is no root `package.json` and no workspaces configured — run package scripts from inside each subdir.

A root `docker-compose.yml` builds both. The CLI service is gated behind `--profile cli` because its SSO flow (browser + loopback callback) doesn't work cleanly in a container.

## Common commands

Both packages expose the same scripts. Run from the respective subdir:

```bash
bun install
bun run dev            # hot-reload
bun run typecheck
bun run fix            # Biome lint + format
bun test
bun test <file>        # single file, e.g. bun test tests/components/Login.test.tsx
```

CLI-only: `bun run build` (bundles via `build.ts`), `bun run start` (runs the built `dist/index.js` via node).

## Architecture: how the pieces fit together

The login flow crosses both packages — understanding it requires reading files in both.

```
codev-cli (src/auth.ts)              codev-proxy (src/index.ts)          Gateway
─────────────────────────            ─────────────────────────           ───────
 login()
 │
 ├─ OAuth2 PKCE via Bun.serve
 │  loopback on 127.0.0.1
 │  → redirects to SSO_BASE_URL/authorize
 │  → exchanges code at /token
 │  → fetches /userinfo
 │  → caches tokens in ~/.codev/auth.json
 │
 └─ fetchApiKey(access_token)
     POST http://localhost:8787/auth/exchange
     Authorization: Bearer <access_token>
                                  │
                                  ▼
                    verifySsoToken(token)
                    GET SSO_USERINFO_URL
                    → { sub, email, displayName }
                                  │
                                  ▼
                    getOrProvisionKey(user)
                    POST API_URL
                    Authorization: Bearer AUTH_TOKEN
                    Body: { username: user.email }
                                                         │
                                                         ▼
                                                Gateway response:
                                                { key_token: "sk-..." }
                                  ◀──────────────────────
                    Returns { api_key, user } to CLI
```

Key invariants across the boundary:

- **The CLI is the SSO client, not the proxy.** All OIDC/PKCE state, tokens, and the loopback callback server live in `codev-cli/src/auth.ts`. The proxy only verifies the access token via `/userinfo`.
- **The "gateway" is a single endpoint, not the LiteLLM admin API.** `API_URL` is a full URL (e.g. `https://netmind.viettel.vn/gateway/add_user_and_generate_key`), not a base. The proxy posts `{ username }` and reads `key_token` from the response (with fallback to `api_key`/`key`/`token`).
- **Key reuse is the gateway's responsibility.** The proxy makes one call per exchange and trusts the gateway to return the existing key for an existing user. Don't add local caching without confirming behavior.
- **The CLI's proxy URL is hardcoded.** `codev-cli/src/proxy.ts` targets `http://localhost:8787` as a module constant — the CLI has no runtime env vars and ships no `.env.example`.
- **`NODE_ENV` gates key logging in the proxy.** In `development`/`staging` (or unset), `/auth/exchange` logs the API key in plaintext for debugging. In `production`, only the email is logged. The proxy's Dockerfile sets `NODE_ENV=production`.

## Tech conventions shared by both packages

- Bun is the runtime, test runner, bundler, and package manager — never Node/npm/jest/webpack. See `codev-cli/CLAUDE.md` for the full list of Bun APIs to prefer (`Bun.serve`, `bun:sqlite`, `Bun.sql`, etc.) and not to reach for Express/ws/dotenv/pg.
- TypeScript config is strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- Biome is the only formatter/linter. Tab indentation, double quotes. `bun run fix` before committing.
- Absolute imports via `@/*` alias resolving to `src/*`. No relative imports across more than one level.
- `.env` is never committed or baked into Docker images. Only `codev-proxy` uses runtime env vars (and ships an `.env.example`).

## Deployment

`codev-proxy` is designed to be built and pushed to Docker Hub for DevOps to deploy. See `codev-proxy/README.md` for the deployment contract: required env vars (with secret flags), tagging strategy, and env var injection patterns for K8s / systemd / Swarm / secret managers.

`codev-cli` is distributed as an npm package (`bun run build` produces `dist/index.js`, referenced from `package.json`'s `bin` field).
