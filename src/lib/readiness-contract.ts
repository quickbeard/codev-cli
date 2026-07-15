import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// This is a protocol/schema identifier, not runtime configuration. Change it
// only when READINESS_RUBRIC or the result contract changes, and update the
// proxy/web supported-version constants in the same change. An environment
// override could falsely label one rubric as another and corrupt comparisons.
export const READINESS_RUBRIC_VERSION = "2026-07-14.v1";

export type ReadinessStatus = "pass" | "fail" | "skipped";

export interface ReadinessCriterionDefinition {
	id: string;
	category: string;
	maturityLevel: number;
	description: string;
	applicability: string;
	evidenceRequired: string;
}

export interface ReadinessCriterionResult {
	status: ReadinessStatus;
	numerator: number | null;
	denominator: number;
	rationale: string;
	evidence: string[];
}

export interface ReadinessApplication {
	path: string;
	description: string;
	languages: string[];
}

export interface AgentReadinessOutput {
	rubricVersion: string;
	languages: string[];
	applications: ReadinessApplication[];
	criteria: Record<string, ReadinessCriterionResult>;
	warnings: string[];
	recommendations: string[];
	model: string | null;
}

const CATEGORIES: Array<[string, number, string[]]> = [
	[
		"Style & Validation",
		1,
		[
			"lint_config",
			"type_check",
			"formatter",
			"pre_commit_hooks",
			"strict_typing",
			"naming_consistency",
			"cyclomatic_complexity",
			"large_file_detection",
			"dead_code_detection",
			"duplicate_code_detection",
			"code_modularization",
			"tech_debt_tracking",
			"n_plus_one_detection",
		],
	],
	[
		"Build System",
		2,
		[
			"build_cmd_doc",
			"deps_pinned",
			"vcs_cli_tools",
			"automated_pr_review",
			"agentic_development",
			"fast_ci_feedback",
			"build_performance_tracking",
			"deployment_frequency",
			"single_command_setup",
			"feature_flag_infrastructure",
			"release_notes_automation",
			"progressive_rollout",
			"rollback_automation",
			"monorepo_tooling",
			"heavy_dependency_detection",
			"unused_dependencies_detection",
			"version_drift_detection",
			"release_automation",
			"dead_feature_flag_detection",
		],
	],
	[
		"Testing",
		2,
		[
			"unit_tests_exist",
			"integration_tests_exist",
			"unit_tests_runnable",
			"test_performance_tracking",
			"flaky_test_detection",
			"test_coverage_thresholds",
			"test_naming_conventions",
			"test_isolation",
		],
	],
	[
		"Documentation",
		2,
		[
			"agents_md",
			"readme",
			"automated_doc_generation",
			"skills",
			"documentation_freshness",
			"api_schema_docs",
			"service_flow_documented",
			"agents_md_validation",
		],
	],
	[
		"Dev Environment",
		2,
		[
			"devcontainer",
			"env_template",
			"local_services_setup",
			"database_schema",
			"devcontainer_runnable",
		],
	],
	[
		"Debugging & Observability",
		3,
		[
			"structured_logging",
			"distributed_tracing",
			"metrics_collection",
			"code_quality_metrics",
			"error_tracking_contextualized",
			"alerting_configured",
			"runbooks_documented",
			"deployment_observability",
			"health_checks",
			"circuit_breakers",
			"profiling_instrumentation",
		],
	],
	[
		"Security",
		3,
		[
			"branch_protection",
			"secret_scanning",
			"codeowners",
			"automated_security_review",
			"dependency_update_automation",
			"gitignore_comprehensive",
			"dast_scanning",
			"pii_handling",
			"privacy_compliance",
			"secrets_management",
			"log_scrubbing",
			"min_release_age",
		],
	],
	[
		"Task Discovery",
		4,
		[
			"issue_templates",
			"issue_labeling_system",
			"backlog_health",
			"pr_templates",
		],
	],
	[
		"Product & Analytics",
		5,
		["product_analytics_instrumentation", "error_to_insight_pipeline"],
	],
];

function label(id: string): string {
	return id.replaceAll("_", " ");
}

export const READINESS_RUBRIC: ReadinessCriterionDefinition[] =
	CATEGORIES.flatMap(([category, maturityLevel, ids]) =>
		ids.map((id) => ({
			id,
			category,
			maturityLevel,
			description: `Evaluate whether the repository has effective ${label(id)} support.`,
			applicability:
				"Evaluate each independently deployable application when applicable; otherwise evaluate once at repository level. Skip only when local repository evidence cannot establish the criterion or the criterion genuinely does not apply.",
			evidenceRequired:
				"Cite repository-relative files and, where useful, line numbers or the safe local command whose output supports the judgment.",
		})),
	);

export const READINESS_CRITERION_IDS = READINESS_RUBRIC.map(({ id }) => id);
const CRITERION_SET = new Set(READINESS_CRITERION_IDS);

export interface ReadinessSummary {
	criteriaPassed: number;
	criteriaTotal: number;
	passRate: number;
	level: number;
}

export function summarizeReadiness(
	criteria: Record<string, ReadinessCriterionResult>,
): ReadinessSummary {
	let passed = 0;
	let total = 0;
	for (const item of Object.values(criteria)) {
		if (item.status === "skipped" || item.numerator === null) continue;
		passed += item.numerator / item.denominator;
		total++;
	}
	const passRate =
		total === 0 ? 0 : Math.round((passed / total) * 10_000) / 100;
	return {
		criteriaPassed: Math.round(passed * 100) / 100,
		criteriaTotal: total,
		passRate,
		level:
			passRate >= 80
				? 5
				: passRate >= 60
					? 4
					: passRate >= 40
						? 3
						: passRate >= 20
							? 2
							: 1,
	};
}

function isInside(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(root, path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function evidencePath(evidence: string): string {
	return evidence.split(":", 1)[0]?.trim() ?? "";
}

function isValidEvidence(root: string, evidence: string): boolean {
	const path = evidencePath(evidence);
	return Boolean(
		path && isInside(root, path) && existsSync(resolve(root, path)),
	);
}

export function normalizeReadinessEvidence(
	output: AgentReadinessOutput,
	root: string,
): AgentReadinessOutput {
	return {
		...output,
		criteria: Object.fromEntries(
			Object.entries(output.criteria).map(([id, item]) => [
				id,
				{
					...item,
					evidence: Array.isArray(item.evidence)
						? item.evidence.filter((entry) => isValidEvidence(root, entry))
						: item.evidence,
				},
			]),
		),
	};
}

export function validateReadinessOutput(
	value: unknown,
	root: string,
): string[] {
	const errors: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value))
		return ["Output must be a JSON object."];
	const output = value as Partial<AgentReadinessOutput>;
	if (output.rubricVersion !== READINESS_RUBRIC_VERSION)
		errors.push(`rubricVersion must be ${READINESS_RUBRIC_VERSION}.`);
	if (
		!Array.isArray(output.languages) ||
		output.languages.some((v) => typeof v !== "string")
	)
		errors.push("languages must be an array of strings.");
	if (!Array.isArray(output.applications) || output.applications.length === 0) {
		errors.push("applications must contain at least one application.");
	} else {
		const paths = new Set<string>();
		for (const [index, app] of output.applications.entries()) {
			if (
				!app ||
				typeof app.path !== "string" ||
				!isInside(root, app.path) ||
				!existsSync(resolve(root, app.path))
			)
				errors.push(
					`applications[${index}].path must exist inside the repository.`,
				);
			else if (paths.has(app.path))
				errors.push(`Duplicate application path: ${app.path}.`);
			else paths.add(app.path);
			if (typeof app?.description !== "string" || app.description.trim() === "")
				errors.push(`applications[${index}].description is required.`);
			if (
				!Array.isArray(app?.languages) ||
				app.languages.some((v) => typeof v !== "string")
			)
				errors.push(`applications[${index}].languages must be strings.`);
		}
	}
	if (
		!output.criteria ||
		typeof output.criteria !== "object" ||
		Array.isArray(output.criteria)
	) {
		errors.push("criteria must be an object.");
	} else {
		for (const id of Object.keys(output.criteria))
			if (!CRITERION_SET.has(id)) errors.push(`Unknown criterion: ${id}.`);
		for (const id of READINESS_CRITERION_IDS) {
			const item = output.criteria[id];
			if (!item) {
				errors.push(`Missing criterion: ${id}.`);
				continue;
			}
			if (!["pass", "fail", "skipped"].includes(item.status))
				errors.push(`${id}.status is invalid.`);
			if (!Number.isInteger(item.denominator) || item.denominator <= 0)
				errors.push(`${id}.denominator must be a positive integer.`);
			if (item.status === "skipped") {
				if (item.numerator !== null)
					errors.push(`${id}.numerator must be null when skipped.`);
			} else if (
				!Number.isInteger(item.numerator) ||
				(item.numerator ?? -1) < 0 ||
				(item.numerator ?? 0) > item.denominator
			)
				errors.push(
					`${id}.numerator must be an integer from zero through denominator.`,
				);
			if (typeof item.rationale !== "string" || item.rationale.trim() === "")
				errors.push(`${id}.rationale is required.`);
			if (
				!Array.isArray(item.evidence) ||
				item.evidence.some((v) => typeof v !== "string")
			)
				errors.push(`${id}.evidence must be an array of strings.`);
			for (const evidence of item.evidence ?? []) {
				if (!isValidEvidence(root, evidence))
					errors.push(`${id} references missing evidence: ${evidence}.`);
			}
		}
	}
	if (
		!Array.isArray(output.warnings) ||
		output.warnings.some((v) => typeof v !== "string")
	)
		errors.push("warnings must be an array of strings.");
	if (
		!Array.isArray(output.recommendations) ||
		output.recommendations.length < 2 ||
		output.recommendations.length > 3 ||
		output.recommendations.some((v) => typeof v !== "string")
	)
		errors.push("recommendations must contain 2 or 3 strings.");
	if (output.model !== null && typeof output.model !== "string")
		errors.push("model must be a string or null.");
	return errors;
}

export function readinessJsonSchema(): Record<string, unknown> {
	const criterionSchema = {
		type: "object",
		additionalProperties: false,
		required: ["status", "numerator", "denominator", "rationale", "evidence"],
		properties: {
			status: { enum: ["pass", "fail", "skipped"] },
			numerator: { type: ["integer", "null"] },
			denominator: { type: "integer", minimum: 1 },
			rationale: { type: "string", minLength: 1 },
			evidence: { type: "array", items: { type: "string" } },
		},
	};
	return {
		type: "object",
		additionalProperties: false,
		required: [
			"rubricVersion",
			"languages",
			"applications",
			"criteria",
			"warnings",
			"recommendations",
			"model",
		],
		properties: {
			rubricVersion: {
				type: "string",
				const: READINESS_RUBRIC_VERSION,
			},
			languages: { type: "array", items: { type: "string" } },
			applications: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["path", "description", "languages"],
					properties: {
						path: { type: "string" },
						description: { type: "string" },
						languages: { type: "array", items: { type: "string" } },
					},
				},
			},
			criteria: {
				type: "object",
				additionalProperties: false,
				required: READINESS_CRITERION_IDS,
				properties: Object.fromEntries(
					READINESS_CRITERION_IDS.map((id) => [id, criterionSchema]),
				),
			},
			warnings: { type: "array", items: { type: "string" } },
			recommendations: {
				type: "array",
				minItems: 2,
				maxItems: 3,
				items: { type: "string" },
			},
			model: { type: ["string", "null"] },
		},
	};
}
