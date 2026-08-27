const DEFAULT_MAX_REPAIRS = 2;
export const READINESS_OPENCODE_MODEL = "aigateway/MiniMax/MiniMax-M2.7";

export interface ReadinessRuntimeConfig {
	opencodeModel: string;
	model?: string;
	codexReasoningEffort: "low";
	maxRepairs: number;
	timeoutMs: number;
	maxOutputBytes: number;
}

export function readinessRuntimeConfig(
	modelOverride?: string,
): ReadinessRuntimeConfig {
	const model = modelOverride?.trim() || undefined;
	return {
		model,
		opencodeModel: READINESS_OPENCODE_MODEL,
		codexReasoningEffort: "low",
		maxRepairs: DEFAULT_MAX_REPAIRS,
		timeoutMs: 20 * 60 * 1_000,
		maxOutputBytes: 20 * 1024 * 1024,
	};
}
