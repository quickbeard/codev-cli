import {
	type ApiKeyCreds,
	loadApiKey,
	saveApiKey,
	silentSso,
} from "@/lib/auth.js";
import { fetchApiKey, validateApiKey } from "@/lib/backend.js";
import {
	type Credentials,
	configureClaudeCode,
	configureCodevCode,
	configureCodex,
	configureOpenCode,
	type Tool,
} from "@/lib/configure.js";
import { logInfo, logWarn } from "@/lib/log.js";

// Cap the pre-flight key check so a slow/hung gateway never stalls an agent
// launch. A real /v1/models round-trip is well under this; if it's slower we just
// launch with the existing config — we can't prove the key is dead, so we leave
// it alone.
const PREFLIGHT_TIMEOUT_MS = 2_500;

// Rewrite the launched agent's OWN config with the fresh key — the agent reads
// its config file (settings.json / config.toml / opencode.json), not
// ~/.codev-hub/auth.json, so saving auth.json alone wouldn't help. Only the three
// chat agents are launchable via `codevhub <agent>`; the extension variants aren't.
function reconfigure(tool: Tool, creds: Credentials): void {
	switch (tool) {
		case "claude-code":
			configureClaudeCode(creds);
			break;
		case "codex":
			configureCodex(creds);
			break;
		case "opencode":
			configureOpenCode(creds);
			break;
		case "codev-code":
			configureCodevCode(creds);
			break;
		default:
			break;
	}
}

// Self-heal a dead gateway API key before launching an agent. The gateway issues
// keys whose lifetime CoDev doesn't control (codev-backend delegates to the
// gateway's add_user_and_generate_key endpoint); when one expires or is evicted,
// every agent call 401/403s and the CLI otherwise keeps using the dead key until
// the user re-runs `codevhub install`.
//
// Pre-flight: if the configured key is rejected (401/403), silently mint a fresh
// one — never prompting — and rewrite auth.json + the launched agent's config so
// it picks up the new key on this very launch. Strictly best-effort: it never
// throws and never blocks the launch (a slow gateway is raced out; a non-auth
// error is left alone; an unrefreshable session just prints a hint).
export async function ensureFreshGatewayKey(tool: Tool): Promise<void> {
	try {
		const creds = loadApiKey();
		// Not CoDev-managed (no gateway key on disk) — nothing to refresh.
		if (!creds?.apiKey) return;
		// A key with no chosen model can't be written back into an agent config
		// (configure* requires a model); leave that for `codevhub install`.
		if (!creds.model) return;

		// true = valid; false = 401/403 (dead key); null = error/timeout (can't
		// tell — leave it). Bounded so a slow gateway doesn't stall the launch.
		const valid = await Promise.race([
			validateApiKey(creds.apiKey, creds.baseUrl).catch(() => null),
			new Promise<null>((resolve) => {
				setTimeout(resolve, PREFLIGHT_TIMEOUT_MS, null).unref?.();
			}),
		]);
		if (valid !== false) return;

		logWarn("gateway key rejected at agent launch; attempting auto-refresh", {
			action: "configure.api-key",
			extra: { tool },
		});

		// Mint a fresh key — only if SSO can be satisfied WITHOUT prompting.
		const auth = await silentSso();
		if (!auth) {
			process.stderr.write(
				"Your gateway API key was rejected and your session can't be refreshed " +
					"automatically. Run `codevhub install` to re-authenticate.\n",
			);
			return;
		}
		const apiKey = await fetchApiKey(auth.access_token).catch(() => "");
		if (!apiKey) {
			process.stderr.write(
				"Couldn't obtain a fresh gateway API key. Run `codevhub install` to re-authenticate.\n",
			);
			return;
		}

		const next: ApiKeyCreds = {
			apiKey,
			baseUrl: creds.baseUrl,
			model: creds.model,
			// Keep the configured provider identity — the rewrite below replaces
			// the whole agent config, so dropping it would silently re-label a
			// manually-named provider as the default.
			providerId: creds.providerId,
			providerName: creds.providerName,
		};
		saveApiKey(next);
		reconfigure(tool, next);
		logInfo("refreshed gateway API key at agent launch", {
			action: "configure.api-key",
			extra: { tool },
		});
		process.stderr.write("Refreshed your expired gateway API key.\n");
	} catch (err) {
		// A launch must never be blocked or broken by the refresh.
		logWarn("gateway key auto-refresh failed", { err });
	}
}
