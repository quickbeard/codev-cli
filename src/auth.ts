import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SSO_BASE_URL = "https://netmind.viettel.vn/sso-wrapper";
const CLIENT_ID = "litellm-test";

function authFilePath() {
	return join(homedir(), ".codev", "auth.json");
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

interface TokenResponse {
	access_token: string;
	id_token: string;
	refresh_token?: string;
	expires_in: number;
}

function readAuthFile(): AuthData | null {
	try {
		return JSON.parse(readFileSync(authFilePath(), "utf-8")) as AuthData;
	} catch {
		return null;
	}
}

export function loadAuth(): AuthData | null {
	const data = readAuthFile();
	if (!data) return null;
	if (Date.now() > data.expires_at) return null;
	return data;
}

function saveAuth(data: AuthData) {
	mkdirSync(dirname(authFilePath()), { recursive: true, mode: 0o700 });
	writeFileSync(authFilePath(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function logout(): boolean {
	try {
		unlinkSync(authFilePath());
		return true;
	} catch {
		return false;
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
 *    with state + PKCE, wait for the callback, exchange code for tokens,
 *    fetch userinfo, and persist to ~/.codev/auth.json
 */
export async function login(
	onLog: (msg: string) => void,
	onReady: (openBrowserFn: () => void) => void,
): Promise<AuthData> {
	onLog("Starting SSO login...");

	const existing = loadAuth();
	if (existing) {
		onLog(`Already logged in as ${existing.user.email}`);
		return existing;
	}

	const stale = readAuthFile();
	if (stale?.refresh_token) {
		try {
			onLog("Refreshing session...");
			const refreshed = await refreshTokens(stale.refresh_token);
			const authData: AuthData = {
				access_token: refreshed.access_token,
				id_token: refreshed.id_token,
				refresh_token: refreshed.refresh_token || stale.refresh_token,
				expires_at: Date.now() + refreshed.expires_in * 1000,
				user: stale.user,
			};
			saveAuth(authData);
			onLog(`Logged in as ${authData.user.email}`);
			return authData;
		} catch {
			onLog("Refresh failed, starting full login...");
		}
	}

	const verifier = generateCodeVerifier();
	const challenge = await generateCodeChallenge(verifier);
	const state = crypto.randomUUID();

	const { code, redirectUri } = await getAuthCode(
		onLog,
		onReady,
		state,
		challenge,
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
	onLog(`Logged in as ${authData.user.email}`);
	return authData;
}

async function getAuthCode(
	onLog: (msg: string) => void,
	onReady: (openBrowserFn: () => void) => void,
	expectedState: string,
	codeChallenge: string,
): Promise<{ code: string; redirectUri: string }> {
	return new Promise((resolve, reject) => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname !== "/callback") {
					return new Response("Not found", { status: 404 });
				}

				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");
				const returnedState = url.searchParams.get("state");

				if (error) {
					const desc = url.searchParams.get("error_description") || error;
					server.stop();
					reject(new Error(`SSO login failed: ${desc}`));
					return new Response(loginResultHtml(false, desc), {
						headers: { "Content-Type": "text/html" },
					});
				}

				if (!code) {
					server.stop();
					reject(new Error("No authorization code received"));
					return new Response(
						loginResultHtml(false, "No authorization code received"),
						{ headers: { "Content-Type": "text/html" } },
					);
				}

				if (returnedState !== expectedState) {
					server.stop();
					reject(new Error("State mismatch (possible CSRF attack)"));
					return new Response(loginResultHtml(false, "State mismatch"), {
						headers: { "Content-Type": "text/html" },
					});
				}

				server.stop();
				resolve({
					code,
					redirectUri: `http://127.0.0.1:${server.port}/callback`,
				});

				return new Response(loginResultHtml(true), {
					headers: { "Content-Type": "text/html" },
				});
			},
		});

		const redirectUri = `http://127.0.0.1:${server.port}/callback`;
		const authorizeUrl =
			`${SSO_BASE_URL}/authorize?` +
			`response_type=code` +
			`&client_id=${encodeURIComponent(CLIENT_ID)}` +
			`&redirect_uri=${encodeURIComponent(redirectUri)}` +
			`&scope=openid%20profile%20email%20offline_access` +
			`&state=${expectedState}` +
			`&code_challenge=${codeChallenge}` +
			`&code_challenge_method=S256`;

		onReady(() => {
			onLog("Opening browser for Viettel SSO login...");
			openBrowser(authorizeUrl);
		});

		setTimeout(() => {
			server.stop();
			reject(new Error("Login timed out after 120 seconds"));
		}, 120_000);
	});
}

async function exchangeCode(
	code: string,
	redirectUri: string,
	codeVerifier: string,
): Promise<TokenResponse> {
	const res = await fetch(`${SSO_BASE_URL}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: CLIENT_ID,
			code_verifier: codeVerifier,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Token exchange failed (${res.status}): ${body}`);
	}

	return (await res.json()) as TokenResponse;
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
	const res = await fetch(`${SSO_BASE_URL}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
	});

	if (!res.ok) {
		throw new Error(`Token refresh failed (${res.status})`);
	}

	return (await res.json()) as TokenResponse;
}

async function fetchUserInfo(accessToken: string) {
	const res = await fetch(`${SSO_BASE_URL}/userinfo`, {
		headers: { Authorization: `Bearer ${accessToken}` },
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

function openBrowser(url: string) {
	const cmd =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "start"
				: "xdg-open";
	execFile(cmd, [url]);
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function loginResultHtml(success: boolean, error?: string): string {
	const title = success ? "Login Successful" : "Login Failed";
	const safeError = error ? escapeHtml(error) : "Unknown error";
	const message = success
		? "You have been logged in. You can close this tab and return to the terminal."
		: `Login failed: ${safeError}. Please try again.`;
	const color = success ? "#22c55e" : "#ef4444";

	return `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa">
<div style="text-align:center">
<h1 style="color:${color}">${title}</h1>
<p>${message}</p>
</div>
</body>
</html>`;
}
