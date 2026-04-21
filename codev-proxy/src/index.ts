import { config } from "@/config.ts";
import { getOrProvisionKey, LiteLlmError } from "@/litellm.ts";
import { SsoError, verifySsoToken } from "@/sso.ts";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function extractBearer(req: Request): string | null {
	const header = req.headers.get("authorization");
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1] ?? null;
}

export async function handleExchange(req: Request): Promise<Response> {
	console.log("[exchange] incoming request");
	const token = extractBearer(req);
	if (!token) {
		console.log("[exchange] missing Bearer token");
		return json({ error: "Missing Bearer token" }, 401);
	}

	try {
		const user = await verifySsoToken(token);
		console.log(`[exchange] SSO user=${user.email} sub=${user.sub}`);
		const apiKey = await getOrProvisionKey(user);
		if (config.isProduction) {
			console.log(`[exchange] returning key for ${user.email}`);
		} else {
			console.log(`[exchange] returning key for ${user.email}: ${apiKey}`);
		}
		return json({
			api_key: apiKey,
			user: { sub: user.sub, email: user.email, displayName: user.displayName },
		});
	} catch (err) {
		if (err instanceof SsoError) {
			console.error(`[exchange] SSO error: ${err.message}`);
			return json({ error: err.message }, err.status);
		}
		if (err instanceof LiteLlmError) {
			console.error(`[exchange] LiteLLM error: ${err.message}`);
			return json({ error: err.message }, err.status);
		}
		console.error("Unexpected error in /auth/exchange:", err);
		return json({ error: "Internal server error" }, 500);
	}
}

if (import.meta.main) {
	const server = Bun.serve({
		port: config.port,
		routes: {
			"/health": () => json({ status: "ok" }),
			"/auth/exchange": {
				POST: handleExchange,
			},
		},
		fetch() {
			return json({ error: "Not found" }, 404);
		},
	});

	console.log(
		`codev-proxy listening on http://${server.hostname}:${server.port}`,
	);
}
