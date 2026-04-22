import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import * as childProcess from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthData, loadAuth, login, logout } from "@/auth.js";
import { BASE_URL } from "@/const.js";

const SSO_BASE_URL = `${BASE_URL}sso-wrapper`;
const REVOCATION_ENDPOINT = `${SSO_BASE_URL}/revoke`;

let tempDir: string;
let homedirSpy: ReturnType<typeof spyOn>;

const VALID_AUTH: AuthData = {
	access_token: "test-access-token",
	id_token: "test-id-token",
	expires_at: Date.now() + 3600000,
	user: {
		sub: "testuser",
		email: "test@example.com",
		displayName: "Test User",
	},
};

const EXPIRED_AUTH: AuthData = {
	...VALID_AUTH,
	expires_at: Date.now() - 1000,
};

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-auth-test-"));
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir);
});

afterEach(() => {
	homedirSpy.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
});

function writeAuthFile(data: AuthData) {
	const dir = join(tempDir, ".codev");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), JSON.stringify(data, null, 2));
}

function mockAuthFetch(
	handlers: Partial<Record<string, (url: string) => Promise<Response>>> = {},
) {
	const originalFetch = globalThis.fetch;
	return spyOn(globalThis, "fetch").mockImplementation((async (
		input: string | URL | Request,
	) => {
		const url = typeof input === "string" ? input : (input as Request).url;
		for (const [key, handler] of Object.entries(handlers)) {
			if (handler && url.includes(key)) return handler(url);
		}
		return originalFetch(input);
	}) as typeof fetch);
}

describe("loadAuth", () => {
	test("returns auth data when file exists and is not expired", () => {
		writeAuthFile(VALID_AUTH);
		const result = loadAuth();
		expect(result).not.toBeNull();
		expect(result?.access_token).toBe("test-access-token");
		expect(result?.user.email).toBe("test@example.com");
	});

	test("returns null when file does not exist", () => {
		const result = loadAuth();
		expect(result).toBeNull();
	});

	test("returns null when token is expired", () => {
		writeAuthFile(EXPIRED_AUTH);
		const result = loadAuth();
		expect(result).toBeNull();
	});

	test("returns null when file contains invalid JSON", () => {
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "auth.json"), "not valid json{{{");
		const result = loadAuth();
		expect(result).toBeNull();
	});
});

describe("logout", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		fetchSpy = mockAuthFetch({
			[REVOCATION_ENDPOINT]: async () => new Response("", { status: 200 }),
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	test("removes the auth file", async () => {
		writeAuthFile(VALID_AUTH);
		expect(loadAuth()).not.toBeNull();
		expect(await logout()).toBe(true);
		expect(loadAuth()).toBeNull();
	});

	test("returns false when no auth file exists", async () => {
		expect(await logout()).toBe(false);
	});

	test("posts to revocation endpoint for access_token and refresh_token", async () => {
		writeAuthFile({ ...VALID_AUTH, refresh_token: "test-refresh" });
		await logout();

		const revokeCalls = fetchSpy.mock.calls.filter((c: unknown[]) =>
			String(c[0]).includes("/revoke"),
		);
		expect(revokeCalls.length).toBe(2);

		const bodies = revokeCalls.map(
			(c: unknown[]) =>
				(c[1] as RequestInit | undefined)?.body?.toString() ?? "",
		);
		expect(
			bodies.some((b: string) => b.includes("token_type_hint=access_token")),
		).toBe(true);
		expect(
			bodies.some((b: string) => b.includes("token_type_hint=refresh_token")),
		).toBe(true);
	});
});

describe("login", () => {
	test("returns existing auth when already logged in", async () => {
		writeAuthFile(VALID_AUTH);
		const logs: string[] = [];
		const onReady = mock();

		const result = await login((msg) => logs.push(msg), onReady);

		expect(result.access_token).toBe("test-access-token");
		expect(result.user.email).toBe("test@example.com");
		expect(logs).toContain("Starting SSO login...");
		expect(logs.some((l) => l.includes("Already logged in"))).toBe(true);
		expect(onReady).not.toHaveBeenCalled();
	});

	test("calls onReady when no existing auth", async () => {
		const logs: string[] = [];
		let readyCalled = false;

		const loginPromise = login(
			(msg) => logs.push(msg),
			() => {
				readyCalled = true;
			},
		);

		await new Promise((r) => setTimeout(r, 100));

		expect(readyCalled).toBe(true);
		expect(logs).toContain("Starting SSO login...");

		loginPromise.catch(() => {});
	});
});

function getAuthorizeUrl(spy: ReturnType<typeof spyOn>): URL | null {
	const call = spy.mock.calls[0];
	if (!call) return null;
	return new URL(call[1]?.[0] as string);
}

function getCallbackPort(spy: ReturnType<typeof spyOn>): number {
	const authorizeUrl = getAuthorizeUrl(spy);
	const redirectUri = authorizeUrl?.searchParams.get("redirect_uri");
	if (!redirectUri) return 0;
	return Number.parseInt(new URL(redirectUri).port, 10);
}

function getCallbackState(spy: ReturnType<typeof spyOn>): string {
	return getAuthorizeUrl(spy)?.searchParams.get("state") ?? "";
}

function getCallbackNonce(spy: ReturnType<typeof spyOn>): string {
	return getAuthorizeUrl(spy)?.searchParams.get("nonce") ?? "";
}

describe("login full OAuth flow", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let execFileSpy: ReturnType<typeof spyOn>;
	const originalFetch = globalThis.fetch;

	function mockSsoFetch() {
		fetchSpy = mockAuthFetch({
			"/token": async () =>
				new Response(
					JSON.stringify({
						access_token: "flow-access-token",
						id_token: "flow-id-token",
						expires_in: 3600,
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
			"/userinfo": async () =>
				new Response(
					JSON.stringify({
						sub: "flowuser",
						email: "flow@example.com",
						displayName: "Flow User",
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
		});
	}

	beforeEach(() => {
		execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
			(() => {}) as unknown as typeof childProcess.execFile,
		);
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		execFileSpy?.mockRestore();
	});

	test("exchanges code, saves auth to disk", async () => {
		mockSsoFetch();
		const logs: string[] = [];

		const result = await login(
			(msg) => logs.push(msg),
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(execFileSpy);
				const state = getCallbackState(execFileSpy);
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?code=test-auth-code&state=${state}`,
					);
				}, 50);
			},
		);

		expect(result.access_token).toBe("flow-access-token");
		expect(result.user.email).toBe("flow@example.com");
		expect(result.user.displayName).toBe("Flow User");

		const authFile = join(tempDir, ".codev", "auth.json");
		expect(existsSync(authFile)).toBe(true);
		const saved: AuthData = JSON.parse(readFileSync(authFile, "utf-8"));
		expect(saved.access_token).toBe("flow-access-token");

		expect(logs.some((l) => l.includes("Logged in as"))).toBe(true);
	});

	test("authorize URL includes nonce", async () => {
		mockSsoFetch();

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(execFileSpy);
				const state = getCallbackState(execFileSpy);
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		await loginPromise;

		const nonce = getCallbackNonce(execFileSpy);
		expect(nonce).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	test("rejects when callback receives an error", async () => {
		mockSsoFetch();
		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(execFileSpy);
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?error=access_denied&error_description=User+denied`,
					);
				}, 50);
			},
		);

		expect(loginPromise).rejects.toThrow("SSO login failed: User denied");
	});

	test("rejects when callback state does not match", async () => {
		mockSsoFetch();
		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(execFileSpy);
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?code=abc&state=wrong-state`,
					);
				}, 50);
			},
		);

		expect(loginPromise).rejects.toThrow("State mismatch");
	});

	test("rejects when callback receives no code", async () => {
		mockSsoFetch();
		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(execFileSpy);
				setTimeout(() => {
					originalFetch(`http://localhost:${port}/callback`);
				}, 50);
			},
		);

		expect(loginPromise).rejects.toThrow("No authorization code received");
	});

	test("callback server returns 404 for non-callback paths", async () => {
		mockSsoFetch();
		let callbackPort = 0;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				callbackPort = getCallbackPort(execFileSpy);
			},
		);

		await new Promise((r) => setTimeout(r, 100));

		expect(callbackPort).toBeGreaterThan(0);
		const res = await originalFetch(`http://localhost:${callbackPort}/other`);
		expect(res.status).toBe(404);

		loginPromise.catch(() => {});
	});

	test("callback server returns success HTML on valid code", async () => {
		mockSsoFetch();
		let callbackResPromise: Promise<Response> | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(execFileSpy);
				const state = getCallbackState(execFileSpy);
				callbackResPromise = new Promise((resolve) => {
					setTimeout(async () => {
						const res = await originalFetch(
							`http://localhost:${port}/callback?code=c&state=${state}`,
						);
						resolve(res);
					}, 50);
				});
			},
		);

		await loginPromise;
		expect(callbackResPromise).not.toBeNull();
		const callbackRes =
			await (callbackResPromise as unknown as Promise<Response>);
		const html = await callbackRes.text();
		expect(html).toContain("Login Successful");
	});

	test("callback server returns error HTML on error", async () => {
		mockSsoFetch();
		let callbackRes: Response | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(execFileSpy);
				setTimeout(async () => {
					callbackRes = await originalFetch(
						`http://localhost:${port}/callback?error=denied`,
					);
				}, 50);
			},
		);

		await loginPromise.catch(() => {});
		await new Promise((r) => setTimeout(r, 100));
		expect(callbackRes).not.toBeNull();
		const html = await (callbackRes as unknown as Response).text();
		expect(html).toContain("Login Failed");
	});
});
