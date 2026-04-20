# codev-backend

Thin proxy between the `codev-cli` and the LiteLLM proxy.

The CLI owns the full OIDC / PKCE flow with Viettel SSO. Once it has an access
token, it calls this backend to exchange that token for a LiteLLM API key.

## Flow

```
codev-cli  ──(1) POST /auth/exchange  Authorization: Bearer <sso_access_token>
              │
              ▼
codev-backend ──(2) GET  {SSO_USERINFO_URL}  (verify token, read sub + email)
              │
              ▼
              ──(3) GET  {API_URL}/user/info?user_id=<sub>
              │         └─ if user+key exists, reuse it
              │         └─ otherwise POST /user/new (or /key/generate)
              ▼
codev-cli   ◀──  { api_key, user }
```

The backend never generates a new LiteLLM key for a user who already has one.

## Endpoints

### `POST /auth/exchange`

Headers:

- `Authorization: Bearer <sso_access_token>` — the token obtained by the CLI
  from Viettel SSO.

Responses:

- `200 OK`
  ```json
  {
    "api_key": "sk-...",
    "user": { "sub": "...", "email": "...", "displayName": "..." }
  }
  ```
- `401 Unauthorized` — missing or invalid SSO token.
- `502 Bad Gateway` — LiteLLM or SSO provider failure.

### `GET /health`

Returns `{ "status": "ok" }`.

## Configuration

Copy `.env.example` to `.env` and fill in:

| Var                | Required | Secret  | Purpose                                                            |
| ------------------ | -------- | ------- | ------------------------------------------------------------------ |
| `API_URL`          | yes      | no      | Gateway endpoint that provisions/returns a LiteLLM key             |
| `AUTH_TOKEN`       | yes      | **yes** | Bearer token for the gateway — route through a secret store in prod |
| `SSO_USERINFO_URL` | yes      | no      | OIDC userinfo endpoint — used to verify the CLI's SSO access token |
| `PORT`             | no       | no      | HTTP port (default `8787`)                                         |
| `NODE_ENV`         | no       | no      | `production` in prod; anything else enables verbose key logging    |

Bun loads `.env` automatically. The server fails fast on startup if any required var is missing.

## Development

```bash
bun install
bun run dev         # hot-reloading server
bun run typecheck
bun run fix         # Biome lint + format
bun test
```

## Running in production

```bash
bun install --production
bun run start
```

## Deployment (Docker Hub → internal server)

### 1. Build and tag

Tag every image with a version **and** the git SHA. Don't push `:latest` for prod — pinning to a concrete tag makes rollbacks trivial.

```bash
VERSION=0.1.0
SHA=$(git rev-parse --short HEAD)
REPO=your-dockerhub-org/codev-backend

docker build -t $REPO:$VERSION -t $REPO:$SHA .
```

### 2. Push to Docker Hub

```bash
docker login
docker push $REPO:$VERSION
docker push $REPO:$SHA
```

### 3. What to hand DevOps

- The image reference: `your-dockerhub-org/codev-backend:0.1.0`
- The env var table above (they need to populate **required** vars; route **secret** ones through their secret store)
- The health check endpoint: `GET /health`
- The listening port: `8787` (or whatever `PORT` is set to)

### 4. Env var injection patterns

**Never** bake `.env` into the image — `.dockerignore` already excludes it. DevOps should inject at runtime using whichever pattern fits their platform:

- **Kubernetes** — non-secrets in a `ConfigMap`, secrets in a `Secret`, both mounted via `envFrom:` on the Deployment. Wire the `/health` endpoint to `livenessProbe` and `readinessProbe`.
- **Plain docker / systemd** — `docker run --env-file /etc/codev-backend/env ...` with the file owned `root:root` and `chmod 600`, or a systemd unit with `EnvironmentFile=`.
- **Docker Swarm** — `docker secret` for `AUTH_TOKEN`, standard env for the rest.
- **HashiCorp Vault / AWS Secrets Manager / Azure Key Vault** — inject via agent or init container at container start.

The container's Dockerfile sets `NODE_ENV=production` by default, which disables API-key logging. Don't override that in prod.

## Project layout

```
src/
├── index.ts      # Bun.serve routes
├── config.ts     # env var loading
├── sso.ts        # verify SSO access token via userinfo
└── litellm.ts    # get-or-provision LiteLLM key per user
```
