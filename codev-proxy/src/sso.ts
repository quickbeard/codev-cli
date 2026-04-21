import { config } from "@/config.ts";

export interface SsoUser {
	sub: string;
	email: string;
	displayName: string;
}

interface UserinfoResponse {
	sub: string;
	email: string;
	displayName?: string;
	name?: string;
}

export class SsoError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
	}
}

export async function verifySsoToken(accessToken: string): Promise<SsoUser> {
	let res: Response;
	try {
		res = await fetch(config.ssoUserinfoUrl, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			throw new SsoError("SSO userinfo request timed out", 504);
		}
		throw err;
	}

	if (res.status === 401 || res.status === 403) {
		throw new SsoError("Invalid or expired SSO token", 401);
	}
	if (!res.ok) {
		throw new SsoError(`SSO userinfo failed (${res.status})`, 502);
	}

	const body = (await res.json()) as UserinfoResponse;
	if (!body.sub || !body.email) {
		throw new SsoError("SSO userinfo missing sub or email", 502);
	}

	return {
		sub: body.sub,
		email: body.email,
		displayName: body.displayName || body.name || body.sub,
	};
}
