import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { handleExchange } from "@/index.ts";

function fetchRouter(handlers: Record<string, () => Response>): typeof fetch {
	const impl = async (input: string | URL | Request) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		for (const [pattern, handler] of Object.entries(handlers)) {
			if (url.includes(pattern)) return handler();
		}
		throw new Error(`Unmocked fetch: ${url}`);
	};
	return impl as unknown as typeof fetch;
}

describe("handleExchange", () => {
	afterEach(() => {
		spyOn(globalThis, "fetch").mockRestore();
	});

	test("returns 401 when Authorization header is absent", async () => {
		const req = new Request("http://test/auth/exchange", { method: "POST" });
		const res = await handleExchange(req);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Missing Bearer token");
	});

	test("returns 401 when Authorization is not a Bearer token", async () => {
		const req = new Request("http://test/auth/exchange", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz" },
		});
		const res = await handleExchange(req);
		expect(res.status).toBe(401);
	});

	test("returns 200 with api_key and user on the happy path", async () => {
		spyOn(globalThis, "fetch").mockImplementation(
			fetchRouter({
				"/userinfo": () =>
					new Response(
						JSON.stringify({
							sub: "u-1",
							email: "test@viettel.com.vn",
							displayName: "Test",
						}),
						{ status: 200 },
					),
				"/gateway": () =>
					new Response(JSON.stringify({ key_token: "sk-hello" }), {
						status: 200,
					}),
			}),
		);

		const req = new Request("http://test/auth/exchange", {
			method: "POST",
			headers: { Authorization: "Bearer valid-sso-token" },
		});
		const res = await handleExchange(req);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			api_key: string;
			user: { sub: string; email: string; displayName: string };
		};
		expect(body.api_key).toBe("sk-hello");
		expect(body.user).toEqual({
			sub: "u-1",
			email: "test@viettel.com.vn",
			displayName: "Test",
		});
	});

	test("maps SsoError(401) to a 401 response", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("", { status: 401 }),
		);
		const req = new Request("http://test/auth/exchange", {
			method: "POST",
			headers: { Authorization: "Bearer invalid" },
		});
		const res = await handleExchange(req);
		expect(res.status).toBe(401);
	});

	test("maps LiteLlmError(502) to a 502 response", async () => {
		spyOn(globalThis, "fetch").mockImplementation(
			fetchRouter({
				"/userinfo": () =>
					new Response(JSON.stringify({ sub: "u", email: "e@v.com" }), {
						status: 200,
					}),
				"/gateway": () => new Response("boom", { status: 500 }),
			}),
		);

		const req = new Request("http://test/auth/exchange", {
			method: "POST",
			headers: { Authorization: "Bearer t" },
		});
		const res = await handleExchange(req);
		expect(res.status).toBe(502);
	});

	test("returns 502 when gateway response has no key field", async () => {
		spyOn(globalThis, "fetch").mockImplementation(
			fetchRouter({
				"/userinfo": () =>
					new Response(JSON.stringify({ sub: "u", email: "e@v.com" }), {
						status: 200,
					}),
				"/gateway": () =>
					new Response(JSON.stringify({ something_else: true }), {
						status: 200,
					}),
			}),
		);

		const req = new Request("http://test/auth/exchange", {
			method: "POST",
			headers: { Authorization: "Bearer t" },
		});
		const res = await handleExchange(req);
		expect(res.status).toBe(502);
	});
});
