import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getOrProvisionKey, LiteLlmError } from "@/litellm.ts";

const fakeUser = {
	sub: "u-1",
	email: "test@viettel.com.vn",
	displayName: "Test",
};

describe("getOrProvisionKey", () => {
	afterEach(() => {
		spyOn(globalThis, "fetch").mockRestore();
	});

	test("returns key_token from the gateway response", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ key_token: "sk-token-1" }), {
				status: 200,
			}),
		);
		const key = await getOrProvisionKey(fakeUser);
		expect(key).toBe("sk-token-1");
	});

	test("falls back to api_key when key_token is absent", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ api_key: "sk-api" }), { status: 200 }),
		);
		const key = await getOrProvisionKey(fakeUser);
		expect(key).toBe("sk-api");
	});

	test("falls back to key when key_token and api_key are absent", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ key: "sk-key" }), { status: 200 }),
		);
		const key = await getOrProvisionKey(fakeUser);
		expect(key).toBe("sk-key");
	});

	test("falls back to token last", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ token: "sk-tok" }), { status: 200 }),
		);
		const key = await getOrProvisionKey(fakeUser);
		expect(key).toBe("sk-tok");
	});

	test("prefers key_token over api_key, key, and token", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({ key_token: "a", api_key: "b", key: "c", token: "d" }),
				{ status: 200 },
			),
		);
		const key = await getOrProvisionKey(fakeUser);
		expect(key).toBe("a");
	});

	test("throws LiteLlmError(502) on non-ok response", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("boom", { status: 500 }),
		);
		try {
			await getOrProvisionKey(fakeUser);
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(LiteLlmError);
			expect((err as LiteLlmError).status).toBe(502);
			expect((err as LiteLlmError).message).toContain("500");
		}
	});

	test("throws when response contains no key field", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ unrelated: true }), { status: 200 }),
		);
		try {
			await getOrProvisionKey(fakeUser);
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(LiteLlmError);
			expect((err as LiteLlmError).message).toContain("no key");
		}
	});

	test("POSTs { username: email } with Bearer AUTH_TOKEN to API_URL", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ key_token: "sk" }), { status: 200 }),
		);
		await getOrProvisionKey(fakeUser);

		const call = fetchSpy.mock.calls[0];
		const url = call?.[0] as string;
		const init = call?.[1] as RequestInit | undefined;

		expect(url).toBe("http://litellm.test/gateway");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({
			Authorization: "Bearer test-auth-token",
			"Content-Type": "application/json",
		});
		expect(init?.body).toBe(
			JSON.stringify({ username: "test@viettel.com.vn" }),
		);
	});
});
