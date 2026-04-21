import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SsoError, verifySsoToken } from "@/sso.ts";

describe("verifySsoToken", () => {
	afterEach(() => {
		spyOn(globalThis, "fetch").mockRestore();
	});

	test("returns { sub, email, displayName } on 200", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					sub: "user-123",
					email: "test@viettel.com.vn",
					displayName: "Test User",
				}),
				{ status: 200 },
			),
		);

		const user = await verifySsoToken("valid-token");
		expect(user).toEqual({
			sub: "user-123",
			email: "test@viettel.com.vn",
			displayName: "Test User",
		});
	});

	test("falls back to 'name' when displayName is missing", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({ sub: "u", email: "e@v.com", name: "Fallback" }),
				{ status: 200 },
			),
		);
		const user = await verifySsoToken("t");
		expect(user.displayName).toBe("Fallback");
	});

	test("falls back to sub when neither displayName nor name is present", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ sub: "u-123", email: "e@v.com" }), {
				status: 200,
			}),
		);
		const user = await verifySsoToken("t");
		expect(user.displayName).toBe("u-123");
	});

	test("throws SsoError(401) on 401 response", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("", { status: 401 }),
		);
		try {
			await verifySsoToken("bad");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SsoError);
			expect((err as SsoError).status).toBe(401);
		}
	});

	test("throws SsoError(401) on 403 response", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("", { status: 403 }),
		);
		try {
			await verifySsoToken("bad");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SsoError);
			expect((err as SsoError).status).toBe(401);
		}
	});

	test("throws SsoError(502) on other non-ok status", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("", { status: 500 }),
		);
		try {
			await verifySsoToken("x");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SsoError);
			expect((err as SsoError).status).toBe(502);
		}
	});

	test("throws when sub is missing in userinfo body", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ email: "e@v.com" }), { status: 200 }),
		);
		await expect(verifySsoToken("t")).rejects.toThrow("missing sub or email");
	});

	test("throws when email is missing in userinfo body", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ sub: "u" }), { status: 200 }),
		);
		await expect(verifySsoToken("t")).rejects.toThrow("missing sub or email");
	});

	test("throws SsoError(504) when the userinfo fetch times out", async () => {
		spyOn(globalThis, "fetch").mockRejectedValue(
			new DOMException("The operation timed out.", "TimeoutError"),
		);
		try {
			await verifySsoToken("t");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SsoError);
			expect((err as SsoError).status).toBe(504);
			expect((err as SsoError).message).toContain("timed out");
		}
	});

	test("sends Authorization: Bearer <token> to the userinfo endpoint", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ sub: "u", email: "e@v.com" }), {
				status: 200,
			}),
		);
		await verifySsoToken("my-access-token");
		const call = fetchSpy.mock.calls[0];
		const url = call?.[0] as string;
		const init = call?.[1] as RequestInit | undefined;
		expect(url).toBe("http://sso.test/userinfo");
		expect(init?.headers).toMatchObject({
			Authorization: "Bearer my-access-token",
		});
	});
});
