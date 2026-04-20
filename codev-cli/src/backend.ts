interface ExchangeResponse {
	api_key: string;
	user: {
		sub: string;
		email: string;
		displayName: string;
	};
}

interface ErrorResponse {
	error?: string;
}

function backendUrl(): string {
	const url = process.env.BACKEND_URL;
	if (!url) {
		throw new Error("Missing required env var: BACKEND_URL");
	}
	return url.replace(/\/$/, "");
}

export async function fetchApiKey(accessToken: string): Promise<string> {
	const res = await fetch(`${backendUrl()}/auth/exchange`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as ErrorResponse;
		const reason = body.error || res.statusText;
		throw new Error(`Backend /auth/exchange failed (${res.status}): ${reason}`);
	}

	const data = (await res.json()) as ExchangeResponse;
	if (!data.api_key) {
		throw new Error("Backend returned no api_key");
	}
	return data.api_key;
}
