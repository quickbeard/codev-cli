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
import { type AuthData, loadAuth, login } from "@/auth.js";

let tempDir: string;
let homedirSpy: ReturnType<typeof spyOn>;

const VALID_AUTH: AuthData = {
	access_token: "test-access-token",
	id_token: "test-id-token",
	expires_at: Date.now() + 3600000,
	user: {
		sub: "testuser",
		email: "test@viettel.com.vn",
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

describe("loadAuth", () => {
	test("returns auth data when file exists and is not expired", () => {
		writeAuthFile(VALID_AUTH);
		const result = loadAuth();
		expect(result).not.toBeNull();
		expect(result?.access_token).toBe("test-access-token");
		expect(result?.user.email).toBe("test@viettel.com.vn");
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

describe("login", () => {
	test("returns existing auth when already logged in", async () => {
		writeAuthFile(VALID_AUTH);
		const logs: string[] = [];
		const onReady = mock();

		const result = await login((msg) => logs.push(msg), onReady);

		expect(result.access_token).toBe("test-access-token");
		expect(result.user.email).toBe("test@viettel.com.vn");
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

function getCallbackPort(spy: ReturnType<typeof spyOn>): number {
	const call = spy.mock.calls[0];
	if (!call) return 0;
	const authorizeUrl = new URL(call[1]?.[0] as string);
	const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
	if (!redirectUri) return 0;
	return Number.parseInt(new URL(redirectUri).port, 10);
}

describe("login full OAuth flow", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let execFileSpy: ReturnType<typeof spyOn>;
	const originalFetch = globalThis.fetch;

	function mockSsoFetch() {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url = typeof input === "string" ? input : (input as Request).url;

			if (url.includes("/token")) {
				return new Response(
					JSON.stringify({
						access_token: "flow-access-token",
						id_token: "flow-id-token",
						expires_in: 3600,
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}

			if (url.includes("/userinfo")) {
				return new Response(
					JSON.stringify({
						sub: "flowuser",
						email: "flow@viettel.com.vn",
						displayName: "Flow User",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}

			return originalFetch(input);
		}) as typeof fetch);
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
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?code=test-auth-code&state=test`,
					);
				}, 50);
			},
		);

		expect(result.access_token).toBe("flow-access-token");
		expect(result.user.email).toBe("flow@viettel.com.vn");
		expect(result.user.displayName).toBe("Flow User");

		const authFile = join(tempDir, ".codev", "auth.json");
		expect(existsSync(authFile)).toBe(true);
		const saved: AuthData = JSON.parse(readFileSync(authFile, "utf-8"));
		expect(saved.access_token).toBe("flow-access-token");

		expect(logs.some((l) => l.includes("Logged in as"))).toBe(true);
	});

	test("rejects when callback receives an error", async () => {
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

	test("rejects when callback receives no code", async () => {
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
				callbackResPromise = new Promise((resolve) => {
					setTimeout(async () => {
						const res = await originalFetch(
							`http://localhost:${port}/callback?code=c&state=s`,
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
