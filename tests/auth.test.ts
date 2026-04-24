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
import {
	type AuthData,
	buildBrowserCommand,
	loadAuth,
	login,
	logout,
} from "@/auth.js";
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

	test("writes force-login marker so next login re-auths at the IdP", async () => {
		writeAuthFile(VALID_AUTH);
		await logout();
		expect(existsSync(join(tempDir, ".codev", "force-login"))).toBe(true);
	});

	test("does not write marker when there was no auth file to remove", async () => {
		expect(await logout()).toBe(false);
		expect(existsSync(join(tempDir, ".codev", "force-login"))).toBe(false);
	});
});

describe("buildBrowserCommand", () => {
	const url = "https://example.com/authorize?a=1&b=2";

	test("darwin uses `open` with the URL as the only argument", () => {
		const cmd = buildBrowserCommand(url, "darwin");
		expect(cmd.file).toBe("open");
		expect(cmd.args).toEqual([url]);
		expect(cmd.options).toBeUndefined();
	});

	test("linux uses `xdg-open` with the URL as the only argument", () => {
		const cmd = buildBrowserCommand(url, "linux");
		expect(cmd.file).toBe("xdg-open");
		expect(cmd.args).toEqual([url]);
		expect(cmd.options).toBeUndefined();
	});

	test("win32 wraps start in cmd.exe with verbatim-quoted URL", () => {
		const cmd = buildBrowserCommand(url, "win32");
		expect(cmd.file).toBe("cmd.exe");
		// `start`'s first quoted arg is the window title; the URL follows in
		// its own quoted arg so `&` isn't split as a command separator.
		expect(cmd.args).toEqual(["/c", "start", '""', `"${url}"`]);
		expect(cmd.options?.windowsVerbatimArguments).toBe(true);
	});

	test("win32 preserves ampersands and query separators inside the quoted URL", () => {
		const cmd = buildBrowserCommand(
			"https://example.com/path?x=1&y=2&z=3",
			"win32",
		);
		const urlArg = cmd.args[3] ?? "";
		expect(urlArg.startsWith('"')).toBe(true);
		expect(urlArg.endsWith('"')).toBe(true);
		expect(urlArg).toContain("&y=2");
		expect(urlArg).toContain("&z=3");
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

	test("regression: stray request alongside /callback does not throw inside the handler", async () => {
		// Before the port-capture fix, the request handler called
		// `server.address()` on every request. When /callback closes the
		// server, any concurrent or stray request landed on the handler with
		// `server.address()` returning null and crashed with
		// "Cannot destructure property 'port' of 'server.address(...)'".
		// The fix captures the port once at listen-time so the handler never
		// re-reads the address. We assert here that firing /callback together
		// with a non-callback request lets the login resolve cleanly and that
		// no uncaught error surfaces in the test process.
		mockSsoFetch();
		const uncaught: Error[] = [];
		const onUncaught = (err: Error) => uncaught.push(err);
		process.on("uncaughtException", onUncaught);

		try {
			const result = await login(
				() => {},
				(openBrowserFn) => {
					openBrowserFn();
					const port = getCallbackPort(execFileSpy);
					const state = getCallbackState(execFileSpy);
					setTimeout(async () => {
						await Promise.all([
							originalFetch(
								`http://localhost:${port}/callback?code=c&state=${state}`,
							),
							originalFetch(`http://localhost:${port}/anything`).catch(
								() => null,
							),
						]);
					}, 50);
				},
			);
			expect(result.access_token).toBe("flow-access-token");
			// Give the loop a tick so any pending request handler errors surface.
			await new Promise((r) => setTimeout(r, 50));
		} finally {
			process.off("uncaughtException", onUncaught);
		}

		const portMessages = uncaught.filter((e) =>
			e.message.includes("server.address"),
		);
		expect(portMessages).toHaveLength(0);
	});

	test("regression: a follow-up request after the server closes does not crash the handler", async () => {
		// Same root cause as above, exercised via a sequential follow-up: the
		// browser may keep the loopback socket alive and send another request
		// (e.g. a favicon poke) after /callback already triggered server.close().
		mockSsoFetch();
		const uncaught: Error[] = [];
		const onUncaught = (err: Error) => uncaught.push(err);
		process.on("uncaughtException", onUncaught);
		let port = 0;

		try {
			const result = await login(
				() => {},
				(openBrowserFn) => {
					openBrowserFn();
					port = getCallbackPort(execFileSpy);
					const state = getCallbackState(execFileSpy);
					setTimeout(() => {
						originalFetch(
							`http://localhost:${port}/callback?code=c&state=${state}`,
						);
					}, 50);
				},
			);
			expect(result.access_token).toBe("flow-access-token");
			// Now the server has been closed. A follow-up request must not
			// throw inside the handler — either it responds (handler still
			// draining a socket) or the connection refuses; both are fine.
			await originalFetch(`http://localhost:${port}/follow-up`).catch(
				() => null,
			);
			await new Promise((r) => setTimeout(r, 50));
		} finally {
			process.off("uncaughtException", onUncaught);
		}

		const portMessages = uncaught.filter((e) =>
			e.message.includes("server.address"),
		);
		expect(portMessages).toHaveLength(0);
	});
});

describe("login with force-login marker", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let execFileSpy: ReturnType<typeof spyOn>;
	const originalFetch = globalThis.fetch;

	function writeMarker() {
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "force-login"), "");
	}

	function getInitialUrl(): URL {
		const call = execFileSpy.mock.calls[0];
		return new URL(call?.[1]?.[0] as string);
	}

	beforeEach(() => {
		execFileSpy = spyOn(childProcess, "execFile").mockImplementation(
			(() => {}) as unknown as typeof childProcess.execFile,
		);
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
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		execFileSpy?.mockRestore();
	});

	test("opens the wrapper /logout URL first instead of /authorize", async () => {
		writeMarker();
		let openedUrl: URL | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				openedUrl = getInitialUrl();
				// Drive the chain: /logout-done → follow 302 → /callback
				const logoutDoneUri = openedUrl.searchParams.get("redirect_uri");
				const port = Number.parseInt(new URL(logoutDoneUri ?? "").port, 10);
				setTimeout(async () => {
					const redirect = await originalFetch(
						`http://localhost:${port}/logout-done`,
						{ redirect: "manual" },
					);
					const next = new URL(redirect.headers.get("location") ?? "");
					const state = next.searchParams.get("state") ?? "";
					await originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		await loginPromise;
		expect(openedUrl).not.toBeNull();
		expect((openedUrl as unknown as URL).pathname).toBe("/sso-wrapper/logout");
		expect(
			(openedUrl as unknown as URL).searchParams.get("redirect_uri") ?? "",
		).toContain("/logout-done");
	});

	test("/logout-done returns a 302 to /authorize with the original PKCE params", async () => {
		writeMarker();
		let redirectLocation: string | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const initial = getInitialUrl();
				const logoutDoneUri = initial.searchParams.get("redirect_uri");
				const port = Number.parseInt(new URL(logoutDoneUri ?? "").port, 10);
				setTimeout(async () => {
					const redirect = await originalFetch(
						`http://localhost:${port}/logout-done`,
						{ redirect: "manual" },
					);
					redirectLocation = redirect.headers.get("location");
					const next = new URL(redirectLocation ?? "");
					const state = next.searchParams.get("state") ?? "";
					await originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		await loginPromise;
		expect(redirectLocation).not.toBeNull();
		const authorizeUrl = new URL(redirectLocation as unknown as string);
		expect(authorizeUrl.pathname).toBe("/sso-wrapper/authorize");
		expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
		expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorizeUrl.searchParams.get("code_challenge") ?? "").not.toBe("");
		expect(authorizeUrl.searchParams.get("nonce") ?? "").toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	test("clears the force-login marker after a successful login", async () => {
		writeMarker();
		const markerPath = join(tempDir, ".codev", "force-login");
		expect(existsSync(markerPath)).toBe(true);

		await login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const initial = getInitialUrl();
				const logoutDoneUri = initial.searchParams.get("redirect_uri");
				const port = Number.parseInt(new URL(logoutDoneUri ?? "").port, 10);
				setTimeout(async () => {
					const redirect = await originalFetch(
						`http://localhost:${port}/logout-done`,
						{ redirect: "manual" },
					);
					const next = new URL(redirect.headers.get("location") ?? "");
					const state = next.searchParams.get("state") ?? "";
					await originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		expect(existsSync(markerPath)).toBe(false);
	});

	test("uses /authorize directly when no marker is present", async () => {
		let openedUrl: URL | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				openedUrl = getInitialUrl();
				const port = Number.parseInt(
					openedUrl.searchParams.get("redirect_uri")
						? new URL(openedUrl.searchParams.get("redirect_uri") as string).port
						: "0",
					10,
				);
				const state = openedUrl.searchParams.get("state") ?? "";
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		await loginPromise;
		expect((openedUrl as unknown as URL).pathname).toBe(
			"/sso-wrapper/authorize",
		);
	});
});
