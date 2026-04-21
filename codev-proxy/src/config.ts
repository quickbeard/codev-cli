function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

function port(): number {
	const raw = process.env.PORT;
	if (!raw) return 8787;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0 || n > 65535) {
		throw new Error(`Invalid PORT: ${raw}`);
	}
	return n;
}

const nodeEnv = process.env.NODE_ENV ?? "development";

export const config = {
	port: port(),
	apiUrl: required("API_URL"),
	authToken: required("AUTH_TOKEN"),
	ssoUserinfoUrl: required("SSO_USERINFO_URL"),
	nodeEnv,
	isProduction: nodeEnv === "production",
};
