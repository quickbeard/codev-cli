import type { CodevConfig } from "@/lib/auth.js";
import {
	AI_GATEWAY_OPENAI_URL,
	AI_GATEWAY_URL,
	BACKEND_URL,
} from "@/lib/const.js";
import { loggedFetch } from "@/lib/log.js";

interface ExchangeResponse {
	api_key: string;
	user: {
		sub: string;
		email: string;
		displayName: string;
	};
}

// Wire shape of the backend's /config payload. The `supabase*` keys are the
// backend's own field names — renaming them here would silently stop parsing a
// live response — so they're mapped onto CodevConfig's names below.
interface ConfigResponse {
	supabaseUrl: string;
	supabaseAnonKey: string;
	gatewayUrl: string;
}

interface ErrorResponse {
	error?: string;
}

const VALIDATE_TIMEOUT_MS = 5_000;
const MODELS_TIMEOUT_MS = 10_000;
// A real (1-token) completion can be slower than listing models — it actually
// hits inference — so give the smoke test more headroom.
const SMOKE_TIMEOUT_MS = 15_000;
// Backend endpoints are quick: token exchange, a tiny config blob, an analysis
// backend session exchange. Cap so a stalled gateway doesn't hang the CLI.
const BACKEND_TIMEOUT_MS = 10_000;

export interface AnalysisBackendSession {
	access_token: string;
	refresh_token?: string;
	expires_at?: number;
	expires_in?: number;
	user: {
		id: string;
		email: string;
	};
}

export async function fetchApiKey(accessToken: string): Promise<string> {
	const res = await loggedFetch(
		"backend.auth-exchange",
		`${BACKEND_URL}/auth/exchange`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
		},
	);

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as ErrorResponse;
		const reason = body.error || res.statusText;
		throw new Error(`Backend /auth/exchange failed (${res.status}): ${reason}`);
	}

	const data = (await res.json()) as ExchangeResponse;
	// Empty key is not thrown — callers route to manual-credentials fallback.
	return data.api_key ?? "";
}

// Pulls the runtime coordinates the CLI doesn't bake into its source — the
// analysis backend URL/anon key and the public gateway base URL. Called from
// auth.ts on every successful SSO login (fresh + refresh) and persisted into
// ~/.codev-hub/auth.json by saveCodevConfig.
export async function fetchCodevConfig(
	accessToken: string,
): Promise<CodevConfig> {
	const res = await loggedFetch("backend.config", `${BACKEND_URL}/config`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
		signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
	});

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as ErrorResponse;
		const reason = body.error || res.statusText;
		throw new Error(`Backend /config failed (${res.status}): ${reason}`);
	}

	const data = (await res.json()) as ConfigResponse;
	if (!data.supabaseUrl || !data.supabaseAnonKey || !data.gatewayUrl) {
		throw new Error(
			`Backend /config returned incomplete payload: ${JSON.stringify(data)}`,
		);
	}
	return {
		analysisBackendUrl: data.supabaseUrl,
		analysisBackendAnonKey: data.supabaseAnonKey,
		gatewayUrl: data.gatewayUrl,
	};
}

// Validates a key by listing models through the OpenAI-compatible
// `/v1/models` endpoint — the same call fetchModels makes, and the one path the
// gateway is guaranteed to authenticate with the key itself. Returns true on a
// JSON 2xx, false on 401/403 (invalid/revoked), throws on network errors and
// anything else so the caller can tell "key is bad" from "couldn't tell".
//
// This used to hit LiteLLM's `/key/info` at the gateway ROOT. The root is now
// fronted by a web app whose catch-all answers **HTTP 200 with an HTML page to
// any bearer, including a bogus one**, so that probe could never return false:
// the launch-time refresh (refresh.ts) never fired and the "reuse existing
// key" path offered dead keys as valid. `/v1/models` 401s properly. The
// content-type guard is what keeps the same failure from recurring behind
// some other catch-all — a 200 that isn't JSON is "can't tell", never "valid".
export async function validateApiKey(
	apiKey: string,
	baseUrl?: string,
): Promise<boolean> {
	const res = await loggedFetch("gateway.key-check", modelsUrl(baseUrl), {
		method: "GET",
		headers: {
			accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
	});
	if (res.status === 401 || res.status === 403) return false;
	if (!res.ok) {
		throw new Error(`Validation failed (${res.status}): ${res.statusText}`);
	}
	const type = res.headers.get("content-type") ?? "";
	if (!type.toLowerCase().includes("json")) {
		throw new Error(
			`Validation failed: the gateway answered with ${type || "a non-JSON body"} instead of JSON`,
		);
	}
	return true;
}

// Detects whether a thrown error from fetchModels was caused by an invalid
// key (401/403) — as opposed to a network/5xx/timeout. Used by `codevhub model`
// to decide whether to trigger the re-auth flow.
export function isInvalidKeyError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /Models fetch failed \((?:401|403)\)/.test(msg);
}

// Build a `<base>/v1/<suffix>` gateway URL. AI_GATEWAY_OPENAI_URL already ends
// in /v1; manual baseUrls may or may not — normalize either way so we always
// end up with exactly one /v1 segment before the suffix.
function gatewayV1Url(baseUrl: string | undefined, suffix: string): string {
	const base = baseUrl ?? AI_GATEWAY_OPENAI_URL();
	const withV1 = /\/v1\/?$/.test(base)
		? base.replace(/\/$/, "")
		: `${base.replace(/\/$/, "")}/v1`;
	return `${withV1}/${suffix}`;
}

// Hits the OpenAI-compatible /v1/models endpoint.
function modelsUrl(baseUrl?: string): string {
	return gatewayV1Url(baseUrl, "models");
}

// Fetches the list of model IDs available to the given API key. Throws on
// non-2xx, network errors, timeout, or an empty result — callers fail-stop
// (there is no silent fallback to a hardcoded default).
export async function fetchModels(
	apiKey: string,
	baseUrl?: string,
): Promise<string[]> {
	const res = await loggedFetch("gateway.models", modelsUrl(baseUrl), {
		method: "GET",
		headers: {
			accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as ErrorResponse;
		const reason = body.error || res.statusText;
		throw new Error(`Models fetch failed (${res.status}): ${reason}`);
	}
	const data = (await res.json()) as { data?: Array<{ id?: string }> };
	const ids = (data.data ?? [])
		.map((m) => m.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (ids.length === 0) throw new Error("Gateway returned no models");
	return ids;
}

// LiteLLM's aggregated per-model-name view. Lives at the gateway ROOT, not
// under /v1, so it uses a root-stripping join rather than gatewayV1Url. Note
// the root is now fronted by a web app (see validateApiKey), so on the live
// gateway this answers an HTML 200 — the JSON parse fails and the catch below
// returns {}, which is the documented "gateway reports nothing" outcome.
function modelGroupInfoUrl(baseUrl?: string): string {
	const base = baseUrl ?? AI_GATEWAY_URL();
	const stripped = base.replace(/\/?v1\/?$/, "");
	const trailing = stripped.endsWith("/") ? stripped : `${stripped}/`;
	return `${trailing}model_group/info`;
}

interface ModelGroupInfo {
	model_group?: string;
	max_input_tokens?: number | null;
	max_output_tokens?: number | null;
}

// A window as the gateway reports it. Deliberately NOT lib/model-limits.ts's
// ModelLimits: that module reads auth.json, which imports this one, and taking
// its type as a value import would close a require cycle. Callers convert with
// limitsFromWindow.
export interface ModelWindow {
	context: number;
	output?: number;
}

// Per-model context windows, straight from the gateway. Entries whose
// max_input_tokens the gateway hasn't been told are skipped, which today is all
// of them — the field is nullable in LiteLLM and only populated when an admin
// sets it on the model. So this returns {} on the current deployment and the
// static table in lib/model-limits.ts carries every model; the moment an admin
// fills the field in, that model becomes gateway-driven with no CoDev release.
//
// Unlike fetchModels, this NEVER throws and never fail-stops the caller: a
// window is an optimization over a sane default, and install must not break
// because a metadata endpoint 404s on some other gateway build.
export async function fetchModelWindows(
	apiKey: string,
	baseUrl?: string,
): Promise<Record<string, ModelWindow>> {
	try {
		const res = await loggedFetch(
			"gateway.model-limits",
			modelGroupInfoUrl(baseUrl),
			{
				method: "GET",
				headers: {
					accept: "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
			},
		);
		if (!res.ok) return {};
		const data = (await res.json()) as { data?: ModelGroupInfo[] };
		const out: Record<string, ModelWindow> = {};
		for (const entry of data.data ?? []) {
			const id = entry.model_group;
			const context = entry.max_input_tokens;
			if (!id || typeof context !== "number" || context <= 0) continue;
			const output =
				typeof entry.max_output_tokens === "number" &&
				entry.max_output_tokens > 0
					? entry.max_output_tokens
					: undefined;
			out[id] = { context, ...(output ? { output } : {}) };
		}
		return out;
	} catch {
		return {};
	}
}

// Confirms the configured key can actually RUN the chosen model through the
// gateway. validateApiKey and fetchModels (both /v1/models) only prove the key
// authenticates and that models are listable — neither proves inference is
// permitted. This 1-token chat completion catches the gateway 403s ("key not
// allowed to access model", over-budget, edge/WAF blocks) that otherwise stay
// hidden until the agent's first message. Returns null on success, or a short
// human-readable reason (HTTP status + body snippet, or the network error) on
// failure. Never throws — a pre-flight check must not break install/config.
export async function smokeTestModel(
	apiKey: string,
	model: string,
	baseUrl?: string,
): Promise<string | null> {
	try {
		const res = await loggedFetch(
			"gateway.smoke-test",
			gatewayV1Url(baseUrl, "chat/completions"),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
				}),
				signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
			},
		);
		if (res.ok) return null;
		// The 403 body is the gold (loggedFetch also captures it from a clone, so
		// this read is safe) — it's what tells "model access" from "over budget"
		// from a bare edge block. Trim and cap so a huge HTML error page can't
		// blow up the terminal frame.
		const body = (await res.text().catch(() => "")).trim();
		const snippet = body
			? `: ${body.slice(0, 200)}${body.length > 200 ? "…" : ""}`
			: "";
		return `Gateway rejected a test request for ${model} (HTTP ${res.status})${snippet}`;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return `Couldn't reach the gateway to test ${model}: ${msg}`;
	}
}

// The `/supabase/exchange` path and the endpoint's error text keep the
// backend's own route name — it's the literal URL a reader has to grep the
// backend for when this fails.
export async function fetchAnalysisBackendSession(
	accessToken: string,
): Promise<AnalysisBackendSession> {
	const res = await loggedFetch(
		"backend.analysis-exchange",
		`${BACKEND_URL}/supabase/exchange`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
		},
	);

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as ErrorResponse;
		const reason = body.error || res.statusText;
		throw new Error(
			`Backend /supabase/exchange failed (${res.status}): ${reason}`,
		);
	}

	return (await res.json()) as AnalysisBackendSession;
}
