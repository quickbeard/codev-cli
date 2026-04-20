function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

const nodeEnv = process.env.NODE_ENV ?? "development";

export const config = {
	port: Number(process.env.PORT ?? 8787),
	apiUrl: required("API_URL"),
	authToken: required("AUTH_TOKEN"),
	ssoUserinfoUrl: required("SSO_USERINFO_URL"),
	nodeEnv,
	isProduction: nodeEnv === "production",
};
