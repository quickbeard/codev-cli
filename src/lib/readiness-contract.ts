import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// This is a protocol/schema identifier, not runtime configuration. Change it
// only when READINESS_RUBRIC or the result contract changes, and update the
// proxy/web supported-version constants in the same change. An environment
// override could falsely label one rubric as another and corrupt comparisons.
export const READINESS_RUBRIC_VERSION = "2026-07-15.v2";

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

const CRITERION_PASS_CONDITIONS: Record<string, string> = {
	lint_config:
		"Pass only when the repository configures a language-appropriate linter and exposes a usable lint command.",
	type_check:
		"Pass only when typed code has a configured, runnable static type-check command; pass untyped-language repositories only when an equivalent static analyzer is configured.",
	formatter:
		"Pass only when an automatic formatter and its repository configuration or command are present.",
	pre_commit_hooks:
		"Pass only when version-controlled pre-commit hooks run meaningful validation before commits.",
	strict_typing:
		"Pass only when the primary typed languages enable strict type checking or comparably strong settings.",
	naming_consistency:
		"Pass only when representative source files and enforced conventions show consistent language-idiomatic naming.",
	cyclomatic_complexity:
		"Pass only when tooling measures or limits code complexity in normal development or CI.",
	large_file_detection:
		"Pass only when automation detects or blocks oversized source files or generated/binary additions.",
	dead_code_detection:
		"Pass only when configured tooling detects unused or unreachable code.",
	duplicate_code_detection:
		"Pass only when configured clone-detection tooling detects repeated code blocks; duplicate object-key lint rules do not count.",
	code_modularization:
		"Pass only when representative source structure has cohesive modules with clear boundaries and avoids dominant god modules.",
	tech_debt_tracking:
		"Pass only when the repository has an actionable, maintained mechanism for tracking technical debt.",
	n_plus_one_detection:
		"Pass only when database access has automated N+1 query detection, query-count assertions, or equivalent safeguards.",
	build_cmd_doc:
		"Pass only when a new contributor can find an explicit build command in version-controlled documentation.",
	deps_pinned:
		"Pass only when dependency manifests and lockfiles provide reproducible direct and transitive dependency resolution.",
	vcs_cli_tools:
		"Pass only when documentation names actual version-control or hosting CLI commands for contributor tasks; CI configuration or generic Git usage alone does not pass.",
	automated_pr_review:
		"Pass only when pull or merge requests receive automatic code-quality review beyond basic compilation.",
	agentic_development:
		"Pass only when repository instructions, tools, or workflows explicitly support coding agents with safe, actionable context.",
	fast_ci_feedback:
		"Pass only when the complete CI workflow set gives early feedback through independently running focused jobs, parallel jobs, or explicit stages; inspect all workflow files before deciding.",
	build_performance_tracking:
		"Pass only when build duration or regressions are measured over time.",
	deployment_frequency:
		"Pass only when repository automation records or exposes deployment frequency rather than merely supporting deployment.",
	single_command_setup:
		"Pass only when a documented single command or task bootstraps the local development environment.",
	feature_flag_infrastructure:
		"Pass only when application code uses a centralized, testable feature-flag mechanism.",
	release_notes_automation:
		"Pass only when release notes or changelogs are generated or validated automatically from version-controlled inputs.",
	progressive_rollout:
		"Pass only when deployment configuration supports staged, canary, percentage, or cohort-based rollout.",
	rollback_automation:
		"Pass only when a documented automated rollback path exists and identifies the artifact or revision restored.",
	monorepo_tooling:
		"Pass only when a multi-package repository uses workspace-aware orchestration; pass a single-package repository when no monorepo coordination is needed.",
	heavy_dependency_detection:
		"Pass only when dependency size, startup cost, or bundle impact is measured or constrained.",
	unused_dependencies_detection:
		"Pass only when tooling detects unused declared package dependencies; unused imports, variables, or declarations alone do not pass.",
	version_drift_detection:
		"Pass only when automation detects inconsistent tool or dependency versions across repository components.",
	release_automation:
		"Pass only when versioning, artifact creation, and publishing are automated through version-controlled workflows.",
	dead_feature_flag_detection:
		"Pass only when stale feature flags are inventoried, expired, or automatically detected.",
	unit_tests_exist:
		"Pass only when meaningful unit tests are present for production logic, not merely placeholder tests.",
	integration_tests_exist:
		"Pass only when tests exercise multiple real internal components together or a real service/database boundary; external third parties may be mocked, but a single isolated unit with all collaborators mocked does not count.",
	unit_tests_runnable:
		"Pass only when a documented or manifest-defined unit-test command can run without undocumented manual preparation.",
	test_performance_tracking:
		"Pass only when test duration or slow-test regressions are measured or reported.",
	flaky_test_detection:
		"Pass only when CI detects, retries with reporting, quarantines, or tracks flaky tests.",
	test_coverage_thresholds:
		"Pass only when coverage thresholds are configured and enforced rather than coverage being generated without a gate.",
	test_naming_conventions:
		"Pass only when test locations and names follow a consistent discoverable convention across primary languages.",
	test_isolation:
		"Pass only when test configuration or fixtures prevent shared mutable state and order dependence.",
	agents_md:
		"Pass only when AGENTS.md or CLAUDE.md provides repository-specific instructions for coding agents.",
	readme:
		"Pass only when a repository-root README explains purpose and a usable development entry point.",
	automated_doc_generation:
		"Pass only when reference documentation is generated or checked automatically from source-controlled definitions.",
	skills:
		"Pass only when reusable repository-local coding-agent skills are version controlled in a recognized skills directory.",
	documentation_freshness:
		"Pass only when automation or an explicit maintained process detects stale documentation.",
	api_schema_docs:
		"Pass only when public APIs have a maintained machine-readable schema or generated reference tied to implementation.",
	service_flow_documented:
		"Pass only when important service or request flows are documented with current component interactions.",
	agents_md_validation:
		"Pass only when a script, test, hook, or CI workflow validates coding-agent instruction files; merely having AGENTS.md or CLAUDE.md does not pass.",
	devcontainer:
		"Pass only when a version-controlled dev-container definition exists.",
	env_template:
		"Pass only when repositories that require runtime environment variables provide a safe non-secret template using a recognized naming convention.",
	local_services_setup:
		"Pass only when required local services have a reproducible documented startup mechanism.",
	database_schema:
		"Pass only when database structure is version controlled through schemas or ordered migrations.",
	devcontainer_runnable:
		"Pass only when the dev-container is validated by CI or has evidence that its build and initialization commands are maintained.",
	structured_logging:
		"Pass only when application logging emits structured fields through a centralized logger in representative runtime paths.",
	distributed_tracing:
		"Pass only when cross-service requests carry trace context and emit spans through configured instrumentation; correlated log trace IDs without spans are insufficient.",
	metrics_collection:
		"Pass only when application or service metrics are emitted and exposed to a collection backend.",
	code_quality_metrics:
		"Pass only when code-quality metrics are measured and reported or gated over time.",
	error_tracking_contextualized:
		"Pass only when an error-tracking or aggregation system receives errors with release, environment, request, or user-safe diagnostic context; local structured logs alone are insufficient.",
	alerting_configured:
		"Pass only when actionable alert rules or monitors are version controlled.",
	runbooks_documented:
		"Pass only when operational incidents have discoverable, actionable runbooks.",
	deployment_observability:
		"Pass only when deployments can be correlated with runtime health, logs, errors, or metrics.",
	health_checks:
		"Pass only when deployable services expose meaningful liveness/readiness checks and deployment configuration uses them.",
	circuit_breakers:
		"Pass only when failure-prone remote calls use explicit timeout, retry, and circuit-breaking policies.",
	profiling_instrumentation:
		"Pass only when production-safe profiling or performance instrumentation can be enabled and interpreted.",
	branch_protection:
		"Pass only when local policy-as-code or repository documentation establishes protected review and status-check requirements.",
	secret_scanning:
		"Pass only when committed and incoming changes are automatically scanned for secrets.",
	codeowners: "Pass only when a recognized CODEOWNERS file exists.",
	automated_security_review:
		"Pass only when dependency, static application, or infrastructure security analysis runs automatically.",
	dependency_update_automation:
		"Pass only when a bot or workflow proposes and validates dependency updates.",
	gitignore_comprehensive:
		"Pass only when ignore rules cover generated output, local state, credentials, and ecosystem-specific artifacts without hiding source.",
	dast_scanning:
		"Pass only when a runnable web/API target is tested by automated dynamic security scanning.",
	pii_handling:
		"Pass only when sensitive personal data has explicit classification, minimization, access, and storage controls in code or policy.",
	privacy_compliance:
		"Pass only when applicable privacy obligations have version-controlled implementation or operational guidance.",
	secrets_management:
		"Pass only when runtime secrets come from a managed injection mechanism and are not stored in source-controlled configuration; local .env files alone are not managed secret injection.",
	log_scrubbing:
		"Pass only when every representative logging path redacts or prevents secrets and personal data; a documented cleartext-secret exception is a failure.",
	min_release_age:
		"Pass only when dependency intake policy or automation delays or reviews newly published releases.",
	issue_templates:
		"Pass only when GitHub or GitLab issue templates collect actionable reproduction and context.",
	issue_labeling_system:
		"Pass only when labels are documented or automated enough to support consistent triage.",
	backlog_health:
		"Pass only when version-controlled automation or documented practice keeps stale, duplicate, and unprioritized work visible.",
	pr_templates:
		"Pass only when GitHub pull-request or GitLab merge-request templates provide an actionable review checklist.",
	product_analytics_instrumentation:
		"Pass only when product behavior is measured through intentional, documented events with ownership or schema.",
	error_to_insight_pipeline:
		"Pass only when production errors feed a repeatable triage, prioritization, or issue-creation workflow.",
};

export const READINESS_RUBRIC: ReadinessCriterionDefinition[] =
	CATEGORIES.flatMap(([category, maturityLevel, ids]) =>
		ids.map((id) => ({
			id,
			category,
			maturityLevel,
			description:
				CRITERION_PASS_CONDITIONS[id] ??
				`Pass only when the repository has effective ${label(id)} support.`,
			applicability:
				"CoDev has already determined that this criterion applies. Evaluate it once at repository level and do not skip it.",
			evidenceRequired:
				"Cite repository-relative files and, where useful, line numbers or the safe local command whose output supports the judgment.",
		})),
	);

export const READINESS_CRITERION_IDS = READINESS_RUBRIC.map(({ id }) => id);

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
	if (!path || !isInside(root, path) || !existsSync(resolve(root, path)))
		return false;
	try {
		const target = resolve(root, path);
		return (
			!lstatSync(target).isSymbolicLink() &&
			isInside(realpathSync(root), realpathSync(target))
		);
	} catch {
		return false;
	}
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
	criterionIds: string[] = READINESS_CRITERION_IDS,
	rubricVersion = READINESS_RUBRIC_VERSION,
): string[] {
	const errors: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value))
		return ["Output must be a JSON object."];
	const output = value as Partial<AgentReadinessOutput>;
	if (output.rubricVersion !== rubricVersion)
		errors.push(`rubricVersion must be ${rubricVersion}.`);
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
		const criterionSet = new Set(criterionIds);
		for (const id of Object.keys(output.criteria))
			if (!criterionSet.has(id)) errors.push(`Unknown criterion: ${id}.`);
		for (const id of criterionIds) {
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

export function readinessJsonSchema(
	criterionIds: string[] = READINESS_CRITERION_IDS,
	rubricVersion = READINESS_RUBRIC_VERSION,
): Record<string, unknown> {
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
				const: rubricVersion,
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
				required: criterionIds,
				properties: Object.fromEntries(
					criterionIds.map((id) => [id, criterionSchema]),
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
