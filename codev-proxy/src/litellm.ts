import { config } from "@/config.ts";
import type { SsoUser } from "@/sso.ts";

export class LiteLlmError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
	}
}

interface KeyResponse {
	key_token?: string;
	key?: string;
	api_key?: string;
	token?: string;
}

export async function getOrProvisionKey(user: SsoUser): Promise<string> {
	const username = user.email;
	let res: Response;
	try {
		res = await fetch(config.apiUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.authToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ username }),
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			throw new LiteLlmError("Gateway request timed out", 504);
		}
		throw err;
	}
	console.log(`[gateway] POST ${config.apiUrl} → ${res.status}`);

	if (!res.ok) {
		const body = await res.text();
		throw new LiteLlmError(
			`Gateway request failed (${res.status}): ${body}`,
			502,
		);
	}

	const data = (await res.json()) as KeyResponse;
	const key = data.key_token ?? data.api_key ?? data.key ?? data.token;
	if (!key) {
		throw new LiteLlmError(
			`Gateway returned no key. Response: ${JSON.stringify(data)}`,
			502,
		);
	}
	return key;
}
