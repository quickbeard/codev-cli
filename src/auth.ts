import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SSO_BASE_URL = "https://netmind.viettel.vn/sso-wrapper";
const CLIENT_ID = "litellm-test";
const AUTH_FILE = join(homedir(), ".codev", "auth.json");

export interface AuthData {
	access_token: string;
	id_token: string;
	expires_at: number;
	user: {
		sub: string;
		email: string;
		displayName: string;
	};
}

export function loadAuth(): AuthData | null {
	try {
		const raw = readFileSync(AUTH_FILE, "utf-8");
		const data: AuthData = JSON.parse(raw);
		if (Date.now() > data.expires_at) return null;
		return data;
	} catch {
		return null;
	}
}

function saveAuth(data: AuthData) {
	mkdirSync(dirname(AUTH_FILE), { recursive: true });
	writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

/**
 * Runs the full OAuth2 Authorization Code flow:
 * 1. Start a temporary local HTTP server
 * 2. Open the browser to the SSO /authorize endpoint
 * 3. Wait for the redirect callback with the auth code
 * 4. Exchange the code for tokens via POST /token
 * 5. Fetch user info via GET /userinfo
 * 6. Save everything to ~/.codev/auth.json
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

	const code = await getAuthCode(onLog, onReady);

	const tokenRes = await exchangeCode(code.code, code.redirectUri);

	const user = await fetchUserInfo(tokenRes.access_token);

	const authData: AuthData = {
		access_token: tokenRes.access_token,
		id_token: tokenRes.id_token,
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
): Promise<{ code: string; redirectUri: string }> {
	return new Promise((resolve, reject) => {
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname !== "/callback") {
					return new Response("Not found", { status: 404 });
				}

				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");

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
						{
							headers: { "Content-Type": "text/html" },
						},
					);
				}

				server.stop();
				resolve({
					code,
					redirectUri: `http://localhost:${server.port}/callback`,
				});

				return new Response(loginResultHtml(true), {
					headers: { "Content-Type": "text/html" },
				});
			},
		});

		const redirectUri = `http://localhost:${server.port}/callback`;
		const state = crypto.randomUUID();
		const authorizeUrl =
			`${SSO_BASE_URL}/authorize?` +
			`response_type=code` +
			`&client_id=${encodeURIComponent(CLIENT_ID)}` +
			`&redirect_uri=${encodeURIComponent(redirectUri)}` +
			`&scope=openid%20profile%20email` +
			`&state=${state}`;

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
): Promise<{ access_token: string; id_token: string; expires_in: number }> {
	const res = await fetch(`${SSO_BASE_URL}/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: `Basic ${btoa(`${CLIENT_ID}`)}`,
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Token exchange failed (${res.status}): ${body}`);
	}

	return (await res.json()) as {
		access_token: string;
		id_token: string;
		expires_in: number;
	};
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

function loginResultHtml(success: boolean, error?: string): string {
	const title = success ? "Login Successful" : "Login Failed";
	const message = success
		? "You have been logged in. You can close this tab and return to the terminal."
		: `Login failed: ${error}. Please try again.`;
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
