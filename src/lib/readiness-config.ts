const DEFAULT_MAX_REPAIRS = 2;
const MAX_ALLOWED_REPAIRS = 5;
export const READINESS_OPENCODE_MODEL = "aigateway/MiniMax/MiniMax-M2.7";

function boundedInteger(
	value: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed >= min && parsed <= max
		? parsed
		: fallback;
}

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
		maxRepairs: boundedInteger(
			undefined,
			DEFAULT_MAX_REPAIRS,
			0,
			MAX_ALLOWED_REPAIRS,
		),
		timeoutMs: 20 * 60 * 1_000,
		maxOutputBytes: 20 * 1024 * 1024,
	};
}
