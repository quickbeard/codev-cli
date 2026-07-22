import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import open from "open";
import { fetchCodevConfig } from "@/lib/backend.js";
import { LOGIN_SUCCESS_URL, SSO_URL } from "@/lib/const.js";
import { logDebug, logError, loggedFetch, logWarn } from "@/lib/log.js";
// Type-only: lib/model-limits.ts imports loadModelLimits from here, so a value
// import would close a runtime cycle. `import type` is erased at compile time.
import type { ModelLimits } from "@/lib/model-limits.js";

const CLIENT_ID = atob("bGl0ZWxsbS10ZXN0");
const REVOKE_TIMEOUT_MS = 3_000;
// Token/userinfo endpoints are quick handshakes — cap them so a hung IdP
// surfaces as an error instead of wedging the install flow indefinitely.
const SSO_FETCH_TIMEOUT_MS = 10_000;
// How long we wait for the authorization code to arrive — via the loopback
// callback or a manual paste-back. Generous because a no-browser user may be
// hopping to another device to authenticate and copy the URL back by hand.
const AUTH_CALLBACK_TIMEOUT_MS = 300_000;

function authFilePath() {
	return join(homedir(), ".codev-hub", "auth.json");
}

function forceLoginPath() {
	return join(homedir(), ".codev-hub", "force-login");
}

function markForceLogin() {
	try {
		const path = forceLoginPath();
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, "", { mode: 0o600 });
	} catch {
		// Best-effort; worst case is a silent SSO login on the next run.
	}
}

function clearForceLogin() {
	try {
		unlinkSync(forceLoginPath());
	} catch {
		// Fine if it didn't exist.
	}
}

export interface AuthData {
	access_token: string;
	id_token: string;
	refresh_token?: string;
	expires_at: number;
	user: {
		sub: string;
		email: string;
		displayName: string;
	};
}

export interface ApiKeyCreds {
	apiKey: string;
	baseUrl?: string;
	model?: string;
	// Set only for manually-entered keys, where the user names their own
	// provider. Absent ⇒ the key is SSO-issued and takes the AIGW default
	// (see lib/provider.ts#resolveProvider).
	providerId?: string;
	providerName?: string;
}

// auth.json holds three independent blocks: SSO tokens (issued by the IdP),
// the gateway API key (issued by /auth/exchange or entered manually), and the
// CoDev runtime config (analysis backend coordinates, fetched from the
// backend's /config endpoint on every successful SSO login). They share a file
// because they're written together on a fresh install, but each is updated in
// isolation — saving SSO must not clobber the api_key or codev-config blocks,
// and `codevhub logout` strips SSO while preserving the rest for reuse.
interface AuthFileContents {
	access_token?: string;
	id_token?: string;
	refresh_token?: string;
	expires_at?: number;
	user?: AuthData["user"];
	api_key?: string;
	base_url?: string;
	model?: string;
	provider_id?: string;
	provider_name?: string;
	// Analysis backend coordinates. The keys keep their historical `supabase_*`
	// names — they're what /config returns and what installed machines cache.
	supabase_url?: string;
	supabase_anon_key?: string;
	gateway_url?: string;
	// Per-model context windows as reported by the gateway, cached at the
	// model-choice step. Its own block rather than a field on the api-key block
	// above, precisely because saveApiKey rewrites that block wholesale — a
	// field there would be cleared by every re-save site that didn't thread it
	// through. Absent ⇒ lib/model-limits.ts falls back to its static table.
	model_limits?: Record<string, ModelLimits>;
	// SkillHub session cookie (`skill-hub-session=…`), captured by
	// `codevhub login --admin` for local ADMIN/SUPERADMIN accounts that can't use
	// SSO. SSO users don't have one — skillhubFetch falls back to a Bearer token.
	skillhub_cookie?: string;
}

export interface CodevConfig {
	analysisBackendUrl: string;
	analysisBackendAnonKey: string;
	gatewayUrl: string;
}

interface TokenResponse {
	access_token: string;
	id_token: string;
	refresh_token?: string;
	expires_in: number;
}

// How login() hands the interactive step back to its caller. Beyond opening
// the browser and exposing the authorize URL, `submitManualCode` lets a
// no-browser caller complete the flow by pasting the redirected callback URL
// (or a bare authorization code) back in. It returns an inline error string to
// re-prompt without restarting, or null once the code is accepted — after
// which the login() promise resolves on its own.
//
// `authUrl` is ALWAYS the directly-pasteable /authorize URL — even on the
// force-login path. `openBrowserFn` may instead route a *local* browser through
// the wrapper /logout bounce (to clear the IdP session cookie), but that bounce
// redirects to a loopback-only /logout-done page a remote browser can't reach.
// A no-browser user authenticates on another device, so handing them the
// /authorize URL is the only form that can actually produce a code to paste.
export type OnLoginReady = (
	openBrowserFn: () => void,
	authUrl: string,
	submitManualCode: (pasted: string) => string | null,
) => void;

function readAuthFile(): AuthFileContents | null {
	try {
		return JSON.parse(
			readFileSync(authFilePath(), "utf-8"),
		) as AuthFileContents;
	} catch {
		return null;
	}
}

function writeAuthFile(data: AuthFileContents): void {
	const path = authFilePath();
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// mkdirSync's mode is ignored when the directory already exists, and
	// writeFileSync's mode is ignored when the file already exists, so
	// re-apply permissions explicitly to tighten any pre-existing loose perms.
	chmodSync(dir, 0o700);
	// Atomic write: stage to a per-process tmp sibling, chmod 0o600 *before*
	// rename so the published file never appears world-readable, then rename
	// over the live path. A daemon and a foreground command racing to update
	// auth.json now end up with one whole write or the other — never a torn
	// merge. The random suffix prevents two concurrent writers from clobbering
	// each other's temp file mid-flight.
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// tmp may already be absent.
		}
		throw err;
	}
	// Re-apply mode after rename for the EXDEV / overwrite case where the
	// renamed inode inherits the destination's prior mode on some platforms.
	chmodSync(path, 0o600);
}

export function loadAuth(): AuthData | null {
	const raw = readAuthFile();
	if (!raw) return null;
	if (!raw.access_token || !raw.id_token || !raw.expires_at || !raw.user) {
		return null;
	}
	if (Date.now() > raw.expires_at) return null;
	return {
		access_token: raw.access_token,
		id_token: raw.id_token,
		refresh_token: raw.refresh_token,
		expires_at: raw.expires_at,
		user: raw.user,
	};
}

function saveAuth(data: AuthData): void {
	const existing = readAuthFile() ?? {};
	writeAuthFile({
		...existing,
		access_token: data.access_token,
		id_token: data.id_token,
		refresh_token: data.refresh_token,
		expires_at: data.expires_at,
		user: data.user,
	});
}

// Writes the whole api-key block, so an omitted field *clears* it: callers that
// re-save a key (model switch, re-auth, launch-time refresh) must thread the
// provider pair through, or a manually-named provider silently reverts to the
// AIGW default on the next write.
export function saveApiKey(creds: ApiKeyCreds): void {
	const existing = readAuthFile() ?? {};
	writeAuthFile({
		...existing,
		api_key: creds.apiKey,
		base_url: creds.baseUrl,
		model: creds.model,
		provider_id: creds.providerId,
		provider_name: creds.providerName,
	});
}

export function saveCodevConfig(config: CodevConfig): void {
	const existing = readAuthFile() ?? {};
	writeAuthFile({
		...existing,
		supabase_url: config.analysisBackendUrl,
		supabase_anon_key: config.analysisBackendAnonKey,
		gateway_url: config.gatewayUrl,
	});
}

// Cache the gateway's per-model windows. Skips the write entirely for an empty
// map so a gateway that reports nothing (every max_input_tokens null, which is
// the case today) doesn't churn auth.json on every model-choice step.
export function saveModelLimits(limits: Record<string, ModelLimits>): void {
	if (Object.keys(limits).length === 0) return;
	const existing = readAuthFile() ?? {};
	writeAuthFile({ ...existing, model_limits: limits });
}

export function loadModelLimits(): Record<string, ModelLimits> | null {
	return readAuthFile()?.model_limits ?? null;
}

export function loadApiKey(): ApiKeyCreds | null {
	const raw = readAuthFile();
	if (!raw?.api_key) return null;
	return {
		apiKey: raw.api_key,
		baseUrl: raw.base_url,
		model: raw.model,
		providerId: raw.provider_id,
		providerName: raw.provider_name,
	};
}

// The SkillHub session cookie is stored as the raw `name=value` pair we send
// back verbatim in the Cookie header (matching how the deprecated @skillhub/cli
// persisted it). Written by `codevhub login --admin`; read by skillhubFetch.
export function saveSkillhubCookie(cookie: string): void {
	const existing = readAuthFile() ?? {};
	writeAuthFile({ ...existing, skillhub_cookie: cookie });
}

export function loadSkillhubCookie(): string | null {
	return readAuthFile()?.skillhub_cookie ?? null;
}

// Drops just the SkillHub cookie block, leaving SSO tokens and gateway config
// intact. The `codevhub logout` command calls this alongside logout() for a full
// sign-out; kept separate so the SSO-only logout() (reused by `login --force`)
// never disturbs an admin cookie.
export function clearSkillhubCookie(): boolean {
	const raw = readAuthFile();
	if (!raw?.skillhub_cookie) return false;
	const { skillhub_cookie: _dropped, ...rest } = raw;
	try {
		if (Object.values(rest).some((v) => v !== undefined)) {
			writeAuthFile(rest);
		} else {
			unlinkSync(authFilePath());
		}
	} catch {
		return false;
	}
	return true;
}

export async function logout(): Promise<boolean> {
	const raw = readAuthFile();
	if (!raw) return false;
	const hasSso = !!(raw.access_token || raw.refresh_token);
	if (!hasSso) return false;
	try {
		const preserved: AuthFileContents = {
			api_key: raw.api_key,
			base_url: raw.base_url,
			model: raw.model,
			// The provider pair belongs to the api-key block above and must travel
			// with it. Dropping it here silently re-labels a manually-named
			// provider as the AIGW default on the next config write — the same
			// failure saveApiKey's whole-block rewrite is documented to cause,
			// reached by a different route.
			provider_id: raw.provider_id,
			provider_name: raw.provider_name,
			supabase_url: raw.supabase_url,
			supabase_anon_key: raw.supabase_anon_key,
			gateway_url: raw.gateway_url,
			skillhub_cookie: raw.skillhub_cookie,
			model_limits: raw.model_limits,
		};
		const hasAnything = Object.values(preserved).some((v) => v !== undefined);
		if (hasAnything) {
			writeAuthFile(preserved);
		} else {
			unlinkSync(authFilePath());
		}
	} catch {
		return false;
	}
	// Revoking tokens does not terminate the IdP's browser session cookie, so
	// the next /authorize would otherwise silently return a new code. Mark the
	// next login to force re-authentication via prompt=login.
	markForceLogin();
	await revokeTokens(raw);
	return true;
}

async function revokeTokens(data: AuthFileContents): Promise<void> {
	const endpoint = `${SSO_URL}/revoke`;
	await Promise.all([
		data.access_token
			? revokeToken(endpoint, data.access_token, "access_token")
			: Promise.resolve(),
		data.refresh_token
			? revokeToken(endpoint, data.refresh_token, "refresh_token")
			: Promise.resolve(),
	]);
}

async function revokeToken(
	endpoint: string,
	token: string,
	tokenTypeHint: "access_token" | "refresh_token",
): Promise<void> {
	try {
		await loggedFetch("sso.revoke", endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				token,
				token_type_hint: tokenTypeHint,
				client_id: CLIENT_ID,
			}),
			signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
		});
	} catch {
		// Best-effort; token will expire naturally if revocation fails.
	}
}

function base64UrlEncode(bytes: Uint8Array): string {
	let str = "";
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Runs the full OAuth2 Authorization Code flow with PKCE:
 * 1. Reuse cached tokens if still valid
 * 2. Try a silent refresh if a refresh_token is on disk
 * 3. Otherwise: start a loopback HTTP server, send the user to /authorize
 *    with state + nonce + PKCE, wait for the callback, exchange code for
 *    tokens, fetch userinfo, and persist to ~/.codev-hub/auth.json
 */
export async function login(
	onLog: (msg: string) => void,
	onReady: OnLoginReady,
): Promise<AuthData> {
	// Tee every status line into the diagnostic log so login problems can be
	// reconstructed without the TUI transcript.
	const log = (msg: string) => {
		logDebug(msg, { extra: { flow: "login" } });
		onLog(msg);
	};
	log("Starting SSO login...");

	// Dev escape hatch: when CODEV_BYPASS_LOGIN=1 is set, skip the OAuth flow
	// entirely and persist a stub session. Useful when the SSO wrapper is down
	// and you still need to walk through `codevhub install` to test downstream
	// steps (npm install, configure, model select, etc.). The stub is real
	// auth.json on disk, so subsequent `codevhub claude/codex/opencode` runs and
	// the upload daemon also see a "logged in" state — clear it with
	// `codevhub logout` or by unsetting the env var + `codevhub remove`.
	if (process.env.CODEV_BYPASS_LOGIN === "1") {
		log("CODEV_BYPASS_LOGIN=1 — skipping SSO, using stub session.");
		const authData: AuthData = {
			access_token: "codev-bypass-no-sso",
			id_token: "codev-bypass-no-sso",
			expires_at: Date.now() + 3_600_000,
			user: {
				sub: "codev-bypass",
				email: "bypass@local",
				displayName: "Bypass User",
			},
		};
		saveAuth(authData);
		clearForceLogin();
		log(`Logged in as ${authData.user.email}`);
		return authData;
	}

	const existing = loadAuth();
	if (existing) {
		log(`Already logged in as ${existing.user.email}`);
		return existing;
	}

	const stale = readAuthFile();
	if (stale?.refresh_token) {
		try {
			log("Refreshing session...");
			const authData = await refreshToAuthData(stale.refresh_token);
			saveAuth(authData);
			log(`Logged in as ${authData.user.email}`);
			return authData;
		} catch (err) {
			logWarn("silent token refresh failed; starting full login", { err });
			log("Refresh failed, starting full login...");
		}
	}

	// Force re-auth via the IdP login form (prompt=login) when:
	//   1. ~/.codev-hub/auth.json doesn't exist — typically the user just ran
	//      `codevhub remove` (which wipes the dir), or this is a truly fresh
	//      install. We have no record of prior auth on this machine, so don't
	//      silently ride any IdP browser-session cookie that might still be
	//      valid from another app on the same SSO realm.
	//   2. The force-login sentinel is set — `codevhub logout` writes it because
	//      revoking tokens does not terminate the IdP's session cookie.
	//
	// Keyed off auth.json rather than the ~/.codev-hub/ dir: unrelated code creates
	// the dir as a side effect before login can run — diagnostic logging
	// (lib/log.ts) at the entry of every command, runExport during
	// `codevhub upload` — and a dir-existence probe would misread those as "prior
	// auth on this machine" and skip the forced credential form.
	const forceLogin =
		!existsSync(authFilePath()) || existsSync(forceLoginPath());
	logDebug(`starting authorization code flow (force-login: ${forceLogin})`, {
		extra: { flow: "login", force_login: forceLogin },
	});

	const verifier = generateCodeVerifier();
	const challenge = await generateCodeChallenge(verifier);
	const state = crypto.randomUUID();
	const nonce = crypto.randomUUID();

	const { code, redirectUri } = await getAuthCode(
		log,
		onReady,
		state,
		challenge,
		nonce,
		forceLogin,
	);

	const tokenRes = await exchangeCode(code, redirectUri, verifier);
	const user = await fetchUserInfo(tokenRes.access_token);

	const authData: AuthData = {
		access_token: tokenRes.access_token,
		id_token: tokenRes.id_token,
		refresh_token: tokenRes.refresh_token,
		expires_at: Date.now() + tokenRes.expires_in * 1000,
		user: {
			sub: user.sub,
			email: user.email,
			displayName: user.displayName || user.name || user.sub,
		},
	};

	saveAuth(authData);
	clearForceLogin();
	log(`Logged in as ${authData.user.email}`);
	return authData;
}

// Build a fresh AuthData from a refresh_token (token refresh + userinfo). Shared
// by login()'s silent-refresh branch and silentSso(); it does NOT persist — the
// callers saveAuth() so the write stays at the call site.
async function refreshToAuthData(refreshToken: string): Promise<AuthData> {
	const refreshed = await refreshTokens(refreshToken);
	const user = await fetchUserInfo(refreshed.access_token);
	return {
		access_token: refreshed.access_token,
		id_token: refreshed.id_token,
		refresh_token: refreshed.refresh_token || refreshToken,
		expires_at: Date.now() + refreshed.expires_in * 1000,
		user: {
			sub: user.sub,
			email: user.email,
			displayName: user.displayName || user.name || user.sub,
		},
	};
}

export interface InteractiveAuthCallbacks {
	onLoginUrl?: (url: string) => void;
	onManualSubmit?: (submit: (pasted: string) => string | null) => void;
	onLoginDone?: () => void;
}

export async function ensureInteractiveAuth(
	onStatus: (message: string) => void = () => {},
	callbacks: InteractiveAuthCallbacks = {},
): Promise<AuthData> {
	const auth = loadAuth();
	if (auth) return auth;

	const fresh = await login(onStatus, (openBrowser, url, submitManualCode) => {
		if (callbacks.onLoginUrl) callbacks.onLoginUrl(url);
		else
			onStatus(`If your browser didn't open, visit this URL manually: ${url}`);
		callbacks.onManualSubmit?.(submitManualCode);
		openBrowser();
	});
	callbacks.onLoginDone?.();
	return fresh;
}

// Non-interactive SSO: return a usable session WITHOUT ever prompting — reuse a
// non-expired cached session, else silently refresh via the stored
// refresh_token. Returns null when neither works (no browser/paste fallback), so
// background callers like the agent-launch key auto-refresh can never hijack a
// launch with a login flow. `login()` is the interactive counterpart.
export async function silentSso(): Promise<AuthData | null> {
	const cached = loadAuth();
	if (cached) return cached;
	const stale = readAuthFile();
	if (!stale?.refresh_token) return null;
	try {
		const authData = await refreshToAuthData(stale.refresh_token);
		saveAuth(authData);
		return authData;
	} catch {
		return null;
	}
}

// Best-effort: pull the latest analysis backend coordinates from the backend
// and persist them next to the SSO session. Failure is logged but not thrown —
// downstream accessors (ANALYSIS_BACKEND_URL/ANON_KEY in const.ts) will hard-fail
// later if no values were ever fetched, with a "run codevhub install" message
// that's actionable for the user.
//
// Callers are responsible for invoking this after a successful login:
//   - InstallApp awaits it inline after the npm install completes (no visible
//     Step — the call blocks the transition to `validating-existing`/
//     `key-choice` but doesn't render a spinner of its own).
//   - upload.ts's ensureAuth runs it on the fresh-login branch, and again
//     in the retry path after a 401/403 from the analysis backend (config may
//     have rotated since the last login).
export async function refreshCodevConfig(
	accessToken: string,
	onLog: (msg: string) => void,
): Promise<void> {
	try {
		const config = await fetchCodevConfig(accessToken);
		saveCodevConfig(config);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logWarn("could not refresh CoDev config", { err });
		onLog(`Warning: could not refresh CoDev config: ${message}`);
	}
}

// Extracts OAuth callback params from text the user pasted back during a
// no-browser login. Handles a full callback URL (the unreachable
// http://127.0.0.1:<port>/callback?... their browser landed on), a scheme-less
// "127.0.0.1:<port>/callback?..." (some browsers hide/drop the scheme), a bare
// query string, or a leading "?". Returns null when the paste carries no
// recognizable params — the caller then treats it as a bare authorization code.
function parseCallbackParams(pasted: string): URLSearchParams | null {
	try {
		return new URL(pasted).searchParams;
	} catch {
		// Not a full URL — fall through.
	}
	// Not a parseable URL — e.g. a scheme-less "127.0.0.1:PORT/callback?..."
	// (a digit-led authority isn't a valid URL scheme, so new URL() rejected
	// it) or a bare query string. Slice off everything up to the first "?" so a
	// host/path prefix doesn't get swallowed into the first param's name, then
	// parse just the query.
	const query = pasted.includes("?")
		? pasted.slice(pasted.indexOf("?") + 1)
		: pasted;
	if (/(?:^|&)(?:code|state|error)=/.test(query)) {
		return new URLSearchParams(query);
	}
	return null;
}

async function getAuthCode(
	onLog: (msg: string) => void,
	onReady: OnLoginReady,
	expectedState: string,
	codeChallenge: string,
	nonce: string,
	forceLogin: boolean,
): Promise<{ code: string; redirectUri: string }> {
	return new Promise((resolve, reject) => {
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		// Set once the flow resolves or rejects — by the loopback callback or by
		// a manual paste — so the two paths can't both fire.
		let settled = false;
		const finish = () => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = null;
			}
		};

		// Captured once when listen() completes. The request handler must use
		// this rather than re-reading server.address(), which returns null after
		// server.close() — a stray browser request firing after /callback closed
		// the server (e.g. a keep-alive followup or favicon poke) would otherwise
		// throw "Cannot destructure property 'port' of 'server.address(...)'".
		let boundPort = 0;

		// Build the wrapper /authorize URL for a chosen redirect target. We use two
		// targets — mirroring how standard loopback OAuth CLIs (gh, gcloud, Claude
		// Code) avoid the browser's "local network access" prompt:
		//   • the *local* browser is sent to the loopback callback directly, so the
		//     IdP navigates the browser to 127.0.0.1 (a top-level navigation, never
		//     gated) and our local server captures the code — no public page ever
		//     reaches into localhost;
		//   • the manual paste-back URL points at the public success page, which
		//     simply *shows* the code to copy when the terminal is on another machine.
		// The wrapper keys the code to PKCE (not an exact redirect_uri match), so the
		// token exchange in succeed() can use the loopback redirect_uri for either.
		const buildAuthorizeUrl = (redirectUri: string) =>
			`${SSO_URL}/authorize?` +
			`response_type=code` +
			`&client_id=${encodeURIComponent(CLIENT_ID)}` +
			`&redirect_uri=${encodeURIComponent(redirectUri)}` +
			`&scope=openid%20profile%20email%20offline_access` +
			`&state=${expectedState}` +
			`&nonce=${nonce}` +
			`&code_challenge=${codeChallenge}` +
			`&code_challenge_method=S256`;

		const loopbackRedirectUri = (port: number) =>
			`http://127.0.0.1:${port}/callback`;
		// Opened in the user's local browser: the IdP redirects straight to the
		// loopback callback (a top-level navigation — no prompt) and login completes
		// on its own.
		const loopbackAuthorizeUrl = (port: number) =>
			buildAuthorizeUrl(loopbackRedirectUri(port));
		// Handed to the manual paste-back channel for remote/headless logins: the IdP
		// lands on the public success page, which displays the code to copy back.
		const manualAuthorizeUrl = buildAuthorizeUrl(LOGIN_SUCCESS_URL);

		// Resolve exactly once. The loopback callback and the manual paste-back
		// path both funnel through here, so whichever lands first wins and the
		// other is a no-op (e.g. a slow paste arriving just after the browser
		// completed the round trip).
		const succeed = (code: string) => {
			if (settled) return;
			settled = true;
			finish();
			server.close();
			resolve({
				code,
				redirectUri: `http://127.0.0.1:${boundPort}/callback`,
			});
		};

		const failWith = (err: Error) => {
			if (settled) return;
			settled = true;
			logError("login failed", { err, extra: { flow: "login" } });
			finish();
			server.close();
			reject(err);
		};

		// Manual paste-back for no-browser environments (remote SSH, headless):
		// the user finishes login on another device, lands on the public success
		// page, and copies the code it shows (or the page URL) back here. Accepts a
		// full URL, a bare query string, or a bare code. Returns an inline error
		// string to re-prompt without restarting, or null once the code is accepted
		// (login() then resolves on its own).
		const submitManualCode = (pasted: string): string | null => {
			if (settled) return null;
			const trimmed = pasted.trim();
			if (!trimmed) return "Paste the callback URL (or code) first.";

			const params = parseCallbackParams(trimmed);
			const errParam = params?.get("error");
			if (errParam) {
				const desc = params?.get("error_description") || errParam;
				return `SSO returned an error: ${desc}`;
			}
			// No params → treat the whole paste as a bare authorization code.
			// There's no state to cross-check, but PKCE still binds it to our
			// verifier at the token exchange.
			const code = params ? params.get("code") : trimmed;
			if (!code) return "No authorization code found in the pasted URL.";
			const returnedState = params?.get("state") ?? null;
			if (returnedState !== null && returnedState !== expectedState) {
				return "That URL is from a different login attempt (state mismatch). Use the most recent URL.";
			}

			succeed(code);
			return null;
		};

		const server = createServer((req, res) => {
			const host = req.headers.host ?? "127.0.0.1";
			const url = new URL(req.url ?? "/", `http://${host}`);

			// Step 1 (forceLogin only): CAS has just killed its session cookie
			// and redirected the browser back to us. Now bounce it to /authorize
			// so the wrapper can start a fresh login — this time CAS will show
			// the credential form because there's no session cookie.
			if (url.pathname === "/logout-done") {
				res.writeHead(302, { Location: loopbackAuthorizeUrl(boundPort) });
				res.end();
				return;
			}

			if (url.pathname !== "/callback") {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not found");
				return;
			}

			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			const returnedState = url.searchParams.get("state");

			const respond = (ok: boolean, msg?: string) => {
				// In the loopback flow the wrapper navigates the browser *here* with the
				// code. Once we've captured it, hand the browser on to the hosted
				// success page as the final, user-facing confirmation (failures carry
				// ?error=... so the page can render its own error state).
				const base = LOGIN_SUCCESS_URL;
				let location = base;
				if (!ok) {
					const sep = base.includes("?") ? "&" : "?";
					const desc = encodeURIComponent(msg ?? "Unknown error");
					location = `${base}${sep}error=login_failed&error_description=${desc}`;
				}
				res.writeHead(302, { Location: location });
				res.end();
			};

			if (error) {
				const desc = url.searchParams.get("error_description") || error;
				respond(false, desc);
				failWith(new Error(`SSO login failed: ${desc}`));
				return;
			}

			if (!code) {
				respond(false, "No authorization code received");
				failWith(new Error("No authorization code received"));
				return;
			}

			if (returnedState !== expectedState) {
				respond(false, "State mismatch");
				failWith(new Error("State mismatch (possible CSRF attack)"));
				return;
			}

			respond(true);
			succeed(code);
		});

		server.listen(0, "127.0.0.1", () => {
			boundPort = (server.address() as AddressInfo).port;
			// The *local* browser opens the loopback authorize URL (on force-login,
			// via the /logout bounce that clears the IdP cookie first, then lands on
			// the loopback /logout-done → loopback /authorize). The manual paste-back
			// channel instead gets the public-success-page authorize URL: a remote
			// browser can complete it and copy the code back, whereas the loopback URL
			// would only yield an unreachable 127.0.0.1 page on another machine.
			const initialUrl = forceLogin
				? `${SSO_URL}/logout?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${boundPort}/logout-done`)}`
				: loopbackAuthorizeUrl(boundPort);
			const authorizeUrl = manualAuthorizeUrl;

			// Arm the timeout before handing control to the caller, so a caller
			// that settles synchronously (an immediate manual paste, or a very
			// fast UI) clears a real timer instead of leaking one armed a tick
			// later.
			timeoutHandle = setTimeout(() => {
				timeoutHandle = null;
				failWith(new Error("Login timed out after 5 minutes"));
			}, AUTH_CALLBACK_TIMEOUT_MS);

			onReady(
				() => {
					onLog(
						forceLogin
							? "Opening browser to end existing SSO session and re-login..."
							: "Opening browser for SSO login...",
					);
					openBrowser(initialUrl);
				},
				authorizeUrl,
				submitManualCode,
			);
		});
	});
}

async function exchangeCode(
	code: string,
	redirectUri: string,
	codeVerifier: string,
): Promise<TokenResponse> {
	const res = await loggedFetch("sso.token", `${SSO_URL}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: CLIENT_ID,
			code_verifier: codeVerifier,
		}),
		signal: AbortSignal.timeout(SSO_FETCH_TIMEOUT_MS),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Token exchange failed (${res.status}): ${body}`);
	}

	return (await res.json()) as TokenResponse;
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
	const res = await loggedFetch("sso.refresh", `${SSO_URL}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
		signal: AbortSignal.timeout(SSO_FETCH_TIMEOUT_MS),
	});

	if (!res.ok) {
		throw new Error(`Token refresh failed (${res.status})`);
	}

	return (await res.json()) as TokenResponse;
}

async function fetchUserInfo(accessToken: string) {
	const res = await loggedFetch("sso.userinfo", `${SSO_URL}/userinfo`, {
		headers: { Authorization: `Bearer ${accessToken}` },
		signal: AbortSignal.timeout(SSO_FETCH_TIMEOUT_MS),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to fetch user info (${res.status}): ${body}`);
	}

	return (await res.json()) as {
		sub: string;
		email: string;
		displayName?: string;
		name?: string;
	};
}

// Indirection layer so tests can spy on the browser launch without mocking
// node:child_process. The `open` npm package handles every platform quirk
// (cmd.exe quoting on Windows, xdg-open on Linux, WSL detection) that we
// previously tried to get right by hand.
export const browserOpener = {
	open(url: string): Promise<unknown> {
		return open(url);
	},
};

function openBrowser(url: string) {
	// Fire-and-forget: the loopback callback server resolves the login flow
	// regardless of whether the browser actually launched. The interactive
	// <Login> flow also surfaces this URL (handed to onReady) so the user can
	// paste it manually if the browser never opened.
	browserOpener.open(url).catch(() => {});
}
