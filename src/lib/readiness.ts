import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { login } from "@/lib/auth.js";
import { BACKEND_URL } from "@/lib/const.js";

interface Criterion {
	numerator: number | null;
	denominator: number;
	rationale: string;
}

type Report = Record<string, Criterion>;

const APP_CRITERIA = [
	"lint_config",
	"type_check",
	"formatter",
	"pre_commit_hooks",
	"strict_typing",
	"naming_consistency",
	"cyclomatic_complexity",
	"dead_code_detection",
	"duplicate_code_detection",
	"code_modularization",
	"n_plus_one_detection",
	"heavy_dependency_detection",
	"unused_dependencies_detection",
	"unit_tests_exist",
	"integration_tests_exist",
	"unit_tests_runnable",
	"test_performance_tracking",
	"flaky_test_detection",
	"test_coverage_thresholds",
	"test_naming_conventions",
	"test_isolation",
	"api_schema_docs",
	"database_schema",
	"structured_logging",
	"distributed_tracing",
	"metrics_collection",
	"code_quality_metrics",
	"error_tracking_contextualized",
	"alerting_configured",
	"deployment_observability",
	"health_checks",
	"circuit_breakers",
	"profiling_instrumentation",
	"dast_scanning",
	"pii_handling",
	"log_scrubbing",
	"product_analytics_instrumentation",
	"error_to_insight_pipeline",
] as const;

const REPO_CRITERIA = [
	"large_file_detection",
	"tech_debt_tracking",
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
	"version_drift_detection",
	"release_automation",
	"dead_feature_flag_detection",
	"agents_md",
	"readme",
	"automated_doc_generation",
	"skills",
	"documentation_freshness",
	"service_flow_documented",
	"agents_md_validation",
	"devcontainer",
	"env_template",
	"local_services_setup",
	"devcontainer_runnable",
	"runbooks_documented",
	"branch_protection",
	"secret_scanning",
	"codeowners",
	"automated_security_review",
	"dependency_update_automation",
	"gitignore_comprehensive",
	"privacy_compliance",
	"secrets_management",
	"min_release_age",
	"issue_templates",
	"issue_labeling_system",
	"backlog_health",
	"pr_templates",
] as const;

const ALL_CRITERIA = [...APP_CRITERIA, ...REPO_CRITERIA];

interface AppInfo {
	description: string;
	path: string;
}

function walk(dir: string, maxDepth = 3, depth = 0): string[] {
	if (depth > maxDepth || !existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (
			[
				".git",
				"node_modules",
				".next",
				"dist",
				"build",
				".venv",
				"venv",
			].includes(entry.name)
		)
			continue;
		const path = join(dir, entry.name);
		out.push(path);
		if (entry.isDirectory()) out.push(...walk(path, maxDepth, depth + 1));
	}
	return out;
}

function hasAny(root: string, patterns: RegExp[]) {
	return walk(root).some((path) =>
		patterns.some((pattern) => pattern.test(relative(root, path))),
	);
}

function fileText(path: string) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function detectApps(root: string): Record<string, AppInfo> {
	const apps: Record<string, AppInfo> = {};
	for (const path of walk(root, 2)) {
		if (
			!existsSync(join(path, "package.json")) &&
			!existsSync(join(path, "requirements.txt")) &&
			!existsSync(join(path, "pyproject.toml"))
		)
			continue;
		const rel = relative(root, path) || ".";
		const pkg = fileText(join(path, "package.json"));
		const name = pkg ? (JSON.parse(pkg).name ?? rel) : rel;
		apps[rel] = { path, description: `${name} application` };
	}
	if (Object.keys(apps).length === 0) {
		apps["."] = { path: root, description: "Repository root application" };
	}
	return apps;
}

function scoreApps(
	apps: Record<string, AppInfo>,
	check: (path: string) => boolean,
	label: string,
): Criterion {
	const entries = Object.entries(apps);
	const passed = entries.filter(([, app]) => check(app.path));
	return {
		numerator: passed.length,
		denominator: entries.length,
		rationale: `${passed.length}/${entries.length} apps pass ${label}.`,
	};
}

function criterion(numerator: number | null, rationale: string): Criterion {
	return { numerator, denominator: 1, rationale };
}

function git(args: string[], cwd: string) {
	const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
	return proc.status === 0 ? proc.stdout.trim() : "";
}

function repoUrl(root: string) {
	return git(["config", "--get", "remote.origin.url"], root) || root;
}

function buildReport(root: string, apps: Record<string, AppInfo>): Report {
	const report = Object.fromEntries(
		ALL_CRITERIA.map((id) => [
			id,
			{
				numerator: 0,
				denominator: 1,
				rationale: "No matching evidence found.",
			},
		]),
	) as Report;

	report.lint_config = scoreApps(
		apps,
		(p) =>
			hasAny(p, [
				/eslint\.config\./,
				/\.eslintrc/,
				/biome\.json/,
				/ruff\.toml/,
				/pyproject\.toml/,
			]),
		"linter config",
	);
	report.type_check = scoreApps(
		apps,
		(p) =>
			hasAny(p, [
				/tsconfig\.json/,
				/pyrightconfig\.json/,
				/mypy\.ini/,
				/pyproject\.toml/,
			]),
		"type checking",
	);
	report.formatter = scoreApps(
		apps,
		(p) =>
			hasAny(p, [/prettier/, /biome\.json/, /ruff\.toml/, /pyproject\.toml/]),
		"formatter config",
	);
	report.pre_commit_hooks = scoreApps(
		apps,
		(p) => hasAny(p, [/^\.husky\//, /\.pre-commit-config\.yaml/]),
		"pre-commit hooks",
	);
	report.unit_tests_exist = scoreApps(
		apps,
		(p) => hasAny(p, [/\.test\./, /\.spec\./, /^tests\//, /test_.*\.py$/]),
		"unit tests",
	);
	report.unit_tests_runnable = scoreApps(
		apps,
		(p) =>
			fileText(join(p, "package.json")).includes('"test"') ||
			hasAny(p, [/pytest\.ini/, /pyproject\.toml/]),
		"test command",
	);
	report.database_schema = scoreApps(
		apps,
		(p) => hasAny(p, [/migrations\//, /\.sql$/]),
		"database schema files",
	);
	report.health_checks = scoreApps(
		apps,
		(p) => /\/health|healthcheck/i.test(walk(p, 2).map(fileText).join("\n")),
		"health checks",
	);
	report.structured_logging = scoreApps(
		apps,
		(p) =>
			/pino|winston|logrus|logging\.|structlog|logger/i.test(
				walk(p, 2).map(fileText).join("\n"),
			),
		"structured logging",
	);

	report.agents_md = criterion(
		existsSync(join(root, "AGENTS.md")) ? 1 : 0,
		existsSync(join(root, "AGENTS.md"))
			? "AGENTS.md exists."
			: "AGENTS.md not found.",
	);
	report.readme = criterion(
		existsSync(join(root, "README.md")) ? 1 : 0,
		existsSync(join(root, "README.md"))
			? "README.md exists."
			: "README.md not found.",
	);
	report.deps_pinned = criterion(
		hasAny(root, [
			/package-lock\.json/,
			/pnpm-lock\.yaml/,
			/bun\.lock/,
			/go\.sum/,
			/uv\.lock/,
			/poetry\.lock/,
		])
			? 1
			: 0,
		"Dependency lockfile scan completed.",
	);
	report.env_template = criterion(
		hasAny(root, [/\.env\.example$/, /\.env\.template$/]) ? 1 : 0,
		"Environment template scan completed.",
	);
	report.gitignore_comprehensive = criterion(
		fileText(join(root, ".gitignore")).includes(".env") ? 1 : 0,
		".gitignore secret pattern scan completed.",
	);
	report.devcontainer = criterion(
		hasAny(root, [/^\.devcontainer\/devcontainer\.json$/]) ? 1 : 0,
		"Devcontainer scan completed.",
	);
	report.issue_templates = criterion(
		hasAny(root, [/^\.github\/ISSUE_TEMPLATE\//]) ? 1 : 0,
		"Issue template scan completed.",
	);
	report.pr_templates = criterion(
		hasAny(root, [/pull_request_template/i]) ? 1 : 0,
		"PR template scan completed.",
	);
	report.codeowners = criterion(
		hasAny(root, [/(^|\/)CODEOWNERS$/]) ? 1 : 0,
		"CODEOWNERS scan completed.",
	);
	report.release_automation = criterion(
		hasAny(root, [
			/^\.github\/workflows\/.*release/i,
			/^\.github\/workflows\/.*deploy/i,
		])
			? 1
			: 0,
		"Release workflow scan completed.",
	);
	report.agentic_development = criterion(
		/factory-droid|droid|claude|codex/i.test(
			git(["log", "--oneline", "-50"], root),
		)
			? 1
			: 0,
		"Recent commit authorship scan completed.",
	);
	report.skills = criterion(
		hasAny(root, [
			/(^|\/)\.factory\/skills\//,
			/(^|\/)\.agents\/skills\//,
			/(^|\/)\.claude\/skills\//,
		])
			? 1
			: 0,
		"Agent skill directory scan completed.",
	);

	for (const id of ALL_CRITERIA) {
		const item = report[id];
		if (
			item?.rationale === "No matching evidence found." &&
			APP_CRITERIA.includes(id as (typeof APP_CRITERIA)[number])
		) {
			report[id] = {
				numerator: null,
				denominator: Object.keys(apps).length,
				rationale: "Not evaluated by the deterministic MVP analyzer.",
			};
		}
	}
	return report;
}

export async function runReadiness() {
	const root = process.cwd();
	const apps = detectApps(root);
	const report = buildReport(root, apps);
	const payload = {
		repoUrl: repoUrl(root),
		branch: git(["branch", "--show-current"], root),
		commitHash: git(["rev-parse", "HEAD"], root),
		apps: Object.fromEntries(
			Object.entries(apps).map(([key, app]) => [
				key,
				{ description: app.description },
			]),
		),
		modelUsed: { id: "codev-deterministic-readiness" },
		report,
	};

	const auth = await login(console.error, () => {});
	const res = await fetch(`${BACKEND_URL}/readiness/reports`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${auth.access_token}`,
		},
		body: JSON.stringify(payload),
	});
	if (!res.ok) {
		console.error(
			`Readiness upload failed (${res.status}): ${await res.text()}`,
		);
		return 1;
	}
	const data = (await res.json()) as { report?: { id?: string } };
	console.log(`Stored readiness report ${data.report?.id ?? ""}`);
	return 0;
}
