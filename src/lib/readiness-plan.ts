import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import {
	type AgentReadinessOutput,
	READINESS_CRITERION_IDS,
	type ReadinessApplication,
	type ReadinessCriterionResult,
} from "@/lib/readiness-contract.js";
import {
	builtInReadinessRuleKey,
	bundledStandardProfile,
	enabledProfileCriteria,
	isStandardProfile,
	type ReadinessCriterionConfig,
	type ReadinessProfile,
} from "@/lib/readiness-profile.js";
import { evaluateConfiguredCriterion } from "@/lib/readiness-rules.js";

export type ReadinessDecision =
	| { mode: "semantic"; reason: string; evidence?: string[] }
	| { mode: "not_applicable"; result: ReadinessCriterionResult }
	| { mode: "deterministic"; result: ReadinessCriterionResult };

export interface ReadinessRepositoryProfile {
	files: string[];
	trackedFiles: string[];
	relevantFiles: string[];
	languages: string[];
	applications: ReadinessApplication[];
	hasEnvironmentUsage: boolean;
	hasDatabaseSurface: boolean;
	hasApiSurface: boolean;
	hasLocalServiceRequirement: boolean;
}

export interface ReadinessEvaluationPlan {
	profile: ReadinessRepositoryProfile;
	criteria: Record<string, ReadinessDecision>;
	criteriaOrder: string[];
	definitions: ReadinessCriterionConfig[];
	analyzerVersion: string;
}

const IGNORED_COMPONENT_SEGMENTS = new Set([
	"example",
	"examples",
	"fixture",
	"fixtures",
	"test",
	"tests",
	"vendor",
	"third_party",
]);

const MANIFESTS = new Set([
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"composer.json",
	"Gemfile",
	"mix.exs",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".c": "C",
	".cc": "C++",
	".cpp": "C++",
	".cs": "C#",
	".ex": "Elixir",
	".exs": "Elixir",
	".go": "Go",
	".java": "Java",
	".js": "JavaScript",
	".jsx": "JavaScript",
	".kt": "Kotlin",
	".kts": "Kotlin",
	".php": "PHP",
	".py": "Python",
	".rb": "Ruby",
	".rs": "Rust",
	".swift": "Swift",
	".ts": "TypeScript",
	".tsx": "TypeScript",
};

const RELEVANT_FILE =
	/(^|\/)(AGENTS\.md|CLAUDE\.md|README(?:\.[^/]+)?|CODEOWNERS|\.gitignore|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|docker-compose[^/]*|compose[^/]*|Dockerfile[^/]*|[^/]*(?:config|schema|migration|workflow|pipeline|test|spec)[^/]*)$/i;
const ENV_USAGE =
	/\b(process\.env|import\.meta\.env|os\.(?:getenv|environ)|System\.getenv|ENV\[|getenv\s*\(|env\s*\()/;
const DATABASE_SIGNAL =
	/\b(postgres(?:ql)?|mysql|mariadb|sqlite|mongodb|redis|supabase|prisma|typeorm|sequelize|drizzle|sqlalchemy|django\.db|alembic|flyway|liquibase|diesel)\b/i;
const API_SIGNAL =
	/\b(express|fastify|hono|nestjs|next\/server|flask|fastapi|django|rails|sinatra|spring-web|actix-web|axum|gin-gonic|openapi|swagger|graphql)\b/i;

function isRelevantFile(file: string): boolean {
	return (
		RELEVANT_FILE.test(file) ||
		/(^|\/)(?:\.github\/workflows|\.gitlab\/ci|\.devcontainer|\.husky|scripts?|tests?)(\/|\.)/i.test(
			file,
		)
	);
}

function listedFiles(root: string, args: string[]): string[] {
	const result = spawnSync("git", ["ls-files", ...args, "-z"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
	});
	if (result.status !== 0) return [];
	return result.stdout
		.split("\0")
		.map((file) => file.replace(/^\.\//, ""))
		.filter(Boolean)
		.sort();
}

function safeText(root: string, file: string): string {
	try {
		const content = readFileSync(`${root}/${file}`);
		if (content.byteLength > 256_000 || content.includes(0)) return "";
		return content.toString("utf8");
	} catch {
		return "";
	}
}

function anyFile(files: string[], patterns: RegExp[]): string[] {
	return files.filter((file) => patterns.some((pattern) => pattern.test(file)));
}

function result(
	status: "pass" | "fail" | "skipped",
	rationale: string,
	evidence: string[] = [],
): ReadinessCriterionResult {
	return {
		status,
		numerator: status === "skipped" ? null : status === "pass" ? 1 : 0,
		denominator: 1,
		rationale,
		evidence,
	};
}

function presenceDecision(
	files: string[],
	patterns: RegExp[],
	passRationale: string,
	failRationale: string,
): ReadinessDecision {
	const matches = anyFile(files, patterns);
	return {
		mode: "deterministic",
		result: matches.length
			? result("pass", passRationale, matches.slice(0, 8))
			: result("fail", failRationale),
	};
}

function contentDecision(
	root: string,
	files: string[],
	pattern: RegExp,
	passRationale: string,
	failRationale: string,
): ReadinessDecision {
	const matches = files.filter((file) => pattern.test(safeText(root, file)));
	return {
		mode: "deterministic",
		result: matches.length
			? result("pass", passRationale, matches.slice(0, 8))
			: result("fail", failRationale),
	};
}

function applications(
	files: string[],
	languages: string[],
): ReadinessApplication[] {
	const manifests = files.filter((file) => {
		if (!MANIFESTS.has(basename(file)) && !/\.csproj$/i.test(file))
			return false;
		return !file
			.split("/")
			.some((segment) => IGNORED_COMPONENT_SEGMENTS.has(segment.toLowerCase()));
	});
	const byDirectory = new Map<string, string[]>();
	for (const manifest of manifests) {
		const directory = dirname(manifest) === "." ? "." : dirname(manifest);
		byDirectory.set(directory, [
			...(byDirectory.get(directory) ?? []),
			manifest,
		]);
	}
	if (byDirectory.size === 0) {
		return [{ path: ".", description: "Repository root", languages }];
	}
	return [...byDirectory.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([path, detected]) => ({
			path,
			description: `Component detected from ${detected.map((file) => basename(file)).join(", ")}`,
			languages,
		}));
}

export function buildReadinessEvaluationPlan(
	root: string,
	selectedProfile: ReadinessProfile = bundledStandardProfile(),
): ReadinessEvaluationPlan {
	const trackedFiles = listedFiles(root, ["--cached"]);
	const files = listedFiles(root, [
		"--cached",
		"--others",
		"--exclude-standard",
	]);
	const languages = [
		...new Set(
			files
				.map((file) => LANGUAGE_BY_EXTENSION[extname(file).toLowerCase()])
				.filter((language): language is string => Boolean(language)),
		),
	].sort();
	const relevantFiles = files.filter(isRelevantFile).slice(0, 800);
	const searchableFiles = files.filter((file) =>
		/\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|php|exs?|toml|ya?ml|json|md|env)$/i.test(
			file,
		),
	);
	let hasEnvironmentUsage = false;
	let hasDatabaseSurface = files.some((file) =>
		/(^|\/)(migrations?|schema|prisma)(\/|\.|$)/i.test(file),
	);
	let hasApiSurface = files.some((file) =>
		/(^|\/)(api|routes?|controllers?)(\/|\.|$)/i.test(file),
	);
	let hasLocalServiceRequirement = files.some((file) =>
		/(^|\/)(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$/i.test(file),
	);
	for (const file of searchableFiles.slice(0, 2_000)) {
		if (
			hasEnvironmentUsage &&
			hasDatabaseSurface &&
			hasApiSurface &&
			hasLocalServiceRequirement
		)
			break;
		const text = safeText(root, file);
		if (!hasEnvironmentUsage && ENV_USAGE.test(text))
			hasEnvironmentUsage = true;
		if (!hasDatabaseSurface && DATABASE_SIGNAL.test(text))
			hasDatabaseSurface = true;
		if (!hasApiSurface && API_SIGNAL.test(text)) hasApiSurface = true;
		if (
			!hasLocalServiceRequirement &&
			/(?:localhost|127\.0\.0\.1|docker\s+compose|podman\s+compose)/i.test(text)
		)
			hasLocalServiceRequirement = true;
	}

	const criteria = Object.fromEntries(
		READINESS_CRITERION_IDS.map((id) => [
			id,
			{ mode: "semantic", reason: "Requires contextual repository judgment." },
		]),
	) as Record<string, ReadinessDecision>;

	criteria.agents_md = presenceDecision(
		trackedFiles,
		[
			/^AGENTS\.md$/i,
			/^CLAUDE\.md$/i,
			/(^|\/)AGENTS\.md$/i,
			/(^|\/)CLAUDE\.md$/i,
		],
		"The repository contains coding-agent instructions.",
		"No AGENTS.md or CLAUDE.md coding-agent instructions were found.",
	);
	criteria.readme = presenceDecision(
		trackedFiles,
		[/^README(?:\.[^/]+)?$/i],
		"The repository root contains a README.",
		"No repository-root README was found.",
	);
	criteria.codeowners = presenceDecision(
		trackedFiles,
		[/^CODEOWNERS$/i, /^\.github\/CODEOWNERS$/i, /^docs\/CODEOWNERS$/i],
		"A recognized CODEOWNERS file is present.",
		"No recognized CODEOWNERS file was found.",
	);
	criteria.issue_templates = presenceDecision(
		trackedFiles,
		[/^\.github\/ISSUE_TEMPLATE\//i, /^\.gitlab\/issue_templates\//i],
		"Issue templates are configured.",
		"No GitHub or GitLab issue templates were found.",
	);
	criteria.pr_templates = presenceDecision(
		trackedFiles,
		[
			/^\.github\/(?:PULL_REQUEST_TEMPLATE\/|pull_request_template\.)/i,
			/^\.gitlab\/merge_request_templates\//i,
		],
		"Pull or merge request templates are configured.",
		"No GitHub pull-request or GitLab merge-request templates were found.",
	);
	criteria.devcontainer = presenceDecision(
		trackedFiles,
		[/^\.devcontainer\.json$/i, /^\.devcontainer\/[^/]*\.json$/i],
		"A dev-container definition is present.",
		"No dev-container definition was found.",
	);
	criteria.skills = presenceDecision(
		trackedFiles,
		[
			/(^|\/)(?:\.claude|\.agents|\.codex)\/skills\//i,
			/(^|\/)skills\/[^/]+\/SKILL\.md$/i,
		],
		"Repository-local agent skills are present.",
		"No recognized repository-local agent skills were found.",
	);

	const envTemplates = anyFile(files, [
		/(^|\/)\.env(?:\.[^/]+)*\.(?:example|sample|template|dist)$/i,
		/(^|\/)(?:env\.example|example\.env|sample\.env)$/i,
	]);
	criteria.env_template = {
		mode:
			hasEnvironmentUsage || envTemplates.length
				? "deterministic"
				: "not_applicable",
		result: envTemplates.length
			? result(
					"pass",
					"An environment-variable template is present.",
					envTemplates.slice(0, 8),
				)
			: hasEnvironmentUsage
				? result(
						"fail",
						"The repository consumes environment variables but no recognized example, sample, template, or dist env file was found.",
					)
				: result(
						"skipped",
						"No repository evidence indicates that runtime environment variables are required.",
					),
	};

	const hookFiles = anyFile(trackedFiles, [
		/^\.husky\/(?!_\/)[^/]+$/i,
		/^\.pre-commit-config\.ya?ml$/i,
		/^lefthook\.ya?ml$/i,
		/^\.lefthook\.ya?ml$/i,
	]);
	const meaningfulHooks = hookFiles.filter((file) =>
		/(?:test|lint|check|typecheck|format|build|audit|scan)/i.test(
			safeText(root, file),
		),
	);
	criteria.pre_commit_hooks = {
		mode: "deterministic",
		result: meaningfulHooks.length
			? result(
					"pass",
					"A version-controlled pre-commit hook runs repository validation.",
					meaningfulHooks,
				)
			: result(
					"fail",
					"No version-controlled pre-commit hook running meaningful validation was found.",
				),
	};

	const automationFiles = trackedFiles.filter(
		(file) =>
			/(^|\/)(?:\.github\/workflows|scripts?|ci)(\/|\.)/i.test(file) &&
			!/(?:readiness|rubric|score)/i.test(file),
	);
	const instructionValidation = automationFiles.filter((file) => {
		const text = safeText(root, file);
		return (
			/(?:AGENTS|CLAUDE)\.md/i.test(text) &&
			/(?:validate|check|lint|test|require|exist)/i.test(text)
		);
	});
	criteria.agents_md_validation = {
		mode: "deterministic",
		result: instructionValidation.length
			? result(
					"pass",
					"Automation validates coding-agent instruction files.",
					instructionValidation.slice(0, 8),
				)
			: result(
					"fail",
					"No automation validating AGENTS.md or CLAUDE.md was found.",
				),
	};

	const contributorDocs = trackedFiles.filter((file) =>
		/(^|\/)(?:README(?:\.[^/]+)?|AGENTS\.md|CLAUDE\.md|CONTRIBUTING(?:\.[^/]+)?|docs\/[^/]+)$/i.test(
			file,
		),
	);
	criteria.vcs_cli_tools = contentDecision(
		root,
		contributorDocs,
		/\b(?:git|gh|glab)\s+(?:clone|issue|pr|checkout|switch|rebase|bisect|blame|commit|push|pull|status|diff|log)\b/i,
		"Contributor documentation includes concrete version-control or hosting CLI commands.",
		"Contributor documentation contains no concrete version-control or hosting CLI workflow commands.",
	);
	const flowDocs = contributorDocs.filter((file) => {
		const text = safeText(root, file);
		return (
			/(?:architecture|data flow|request flow|command flow|layered|component interactions?)/i.test(
				text,
			) &&
			/(?:src\/|components?\/|lib\/|API|backend|frontend|worker|proxy|-->|→)/i.test(
				text,
			)
		);
	});
	criteria.service_flow_documented = {
		mode: "deterministic",
		result: flowDocs.length
			? result(
					"pass",
					"Repository documentation describes architecture or an important component flow.",
					flowDocs.slice(0, 8),
				)
			: result(
					"fail",
					"No architecture, request, data, or command flow documentation with component interactions was found.",
				),
	};

	const gitignoreFiles = trackedFiles.filter((file) =>
		/(^|\/)\.gitignore$/i.test(file),
	);
	const gitignoreText = gitignoreFiles
		.map((file) => safeText(root, file))
		.join("\n");
	const ignoreRequirements: Array<[string, RegExp]> = [];
	if (trackedFiles.some((file) => basename(file) === "package.json")) {
		ignoreRequirements.push(
			["Node dependencies", /(?:^|\/)node_modules\/?/im],
			["JavaScript build output", /(?:^|\/)(?:dist|build|out)\/?/im],
		);
	}
	if (
		trackedFiles.some((file) =>
			["pyproject.toml", "requirements.txt", "setup.py"].includes(
				basename(file),
			),
		)
	) {
		ignoreRequirements.push(
			["Python bytecode", /__pycache__|\*\.pyc/im],
			["Python virtual environments", /(?:^|\/)(?:\.venv|venv)\/?/im],
		);
	}
	if (trackedFiles.some((file) => basename(file) === "Cargo.toml"))
		ignoreRequirements.push(["Rust build output", /(?:^|\/)target\/?/im]);
	if (
		trackedFiles.some((file) =>
			["pom.xml", "build.gradle", "build.gradle.kts"].includes(basename(file)),
		)
	)
		ignoreRequirements.push([
			"JVM build output",
			/(?:^|\/)(?:target|build|\.gradle)\/?/im,
		]);
	if (hasEnvironmentUsage)
		ignoreRequirements.push([
			"local environment files",
			/(?:^|\/)\.env(?:[.*]|$)/im,
		]);
	const missingIgnoreGroups = ignoreRequirements
		.filter(([, pattern]) => !pattern.test(gitignoreText))
		.map(([name]) => name);
	criteria.gitignore_comprehensive = {
		mode: "deterministic",
		result:
			gitignoreFiles.length > 0 && missingIgnoreGroups.length === 0
				? result(
						"pass",
						"Git ignore rules cover the repository's detected ecosystems and local configuration.",
						gitignoreFiles,
					)
				: result(
						"fail",
						gitignoreFiles.length === 0
							? "No version-controlled .gitignore was found."
							: `Git ignore rules are missing coverage for: ${missingIgnoreGroups.join(", ")}.`,
						gitignoreFiles,
					),
	};

	const toolingFiles = trackedFiles.filter((file) =>
		/(^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|biome\.json|eslint[^/]*|\.eslintrc[^/]*|sonar-project\.properties|Makefile|Taskfile\.ya?ml|justfile|\.github\/workflows\/[^/]+)$/i.test(
			file,
		),
	);
	criteria.cyclomatic_complexity = contentDecision(
		root,
		toolingFiles,
		/(?:noExcessiveCognitiveComplexity|["']complexity["']\s*:|\bradon\b|\blizard\b|sonar\.(?:cognitive_)?complexity|cyclomatic[-_ ]complexity)/i,
		"Configured tooling measures or limits source-code complexity.",
		"No configured source-code complexity measurement or limit was found.",
	);
	criteria.duplicate_code_detection = contentDecision(
		root,
		toolingFiles,
		/(?:\bjscpd\b|\bsimian\b|\bduplo\b|sonar\.cpd|copy.?paste detector)/i,
		"Configured tooling detects duplicated code blocks.",
		"No configured clone or duplicated-code detector was found.",
	);
	criteria.unused_dependencies_detection = contentDecision(
		root,
		toolingFiles,
		/(?:\bknip\b|\bdepcheck\b|\bunimported\b|cargo\s+udeps|unused[-_ ]dependenc)/i,
		"Configured tooling detects unused declared dependencies.",
		"No configured unused-dependency detector was found.",
	);
	const biomeRecommended = toolingFiles.some(
		(file) =>
			/biome\.jsonc?$/i.test(file) &&
			/["']recommended["']\s*:\s*true/i.test(safeText(root, file)),
	);
	const biomeExecuted = toolingFiles.some(
		(file) =>
			basename(file) === "package.json" &&
			/\bbiome\s+(?:check|lint)\b/i.test(safeText(root, file)),
	);
	const deadCodeTools = toolingFiles.filter((file) =>
		/(?:\bknip\b|\bts-prune\b|\bvulture\b|\bdeadcode\b|cargo\s+udeps|noUnusedLocals["']?\s*:\s*true|noUnusedVariables)/i.test(
			safeText(root, file),
		),
	);
	criteria.dead_code_detection = {
		mode: "deterministic",
		result:
			deadCodeTools.length || (biomeRecommended && biomeExecuted)
				? result(
						"pass",
						"Configured validation detects unused or dead code.",
						deadCodeTools.length
							? deadCodeTools.slice(0, 8)
							: toolingFiles
									.filter((file) =>
										/(?:biome\.json|package\.json)$/i.test(file),
									)
									.slice(0, 8),
					)
				: result(
						"fail",
						"No configured unused-code or dead-code detector was found.",
					),
	};

	const bootstrapFiles = trackedFiles.filter((file) =>
		/(^|\/)(?:package\.json|Makefile|Taskfile\.ya?ml|justfile|README(?:\.[^/]+)?|CONTRIBUTING(?:\.[^/]+)?)$/i.test(
			file,
		),
	);
	criteria.single_command_setup = contentDecision(
		root,
		bootstrapFiles,
		/(?:["'](?:setup|bootstrap|init)["']\s*:|^(?:setup|bootstrap|init)\s*:|\b(?:make|just|task|npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:setup|bootstrap|init)\b)/im,
		"A documented setup, bootstrap, or init task provides a single repository-owned setup command.",
		"No repository-owned single-command setup, bootstrap, or init task was found.",
	);

	const protectionFiles = trackedFiles.filter((file) =>
		/(?:^\.github\/settings\.ya?ml$|\.tf$|rulesets?\/[^/]+\.json$)/i.test(file),
	);
	criteria.branch_protection = contentDecision(
		root,
		protectionFiles,
		/(?:github_branch_protection|github_repository_ruleset|protected_branches?|required_status_checks|required_pull_request_reviews)/i,
		"Version-controlled policy-as-code configures branch protection requirements.",
		"No version-controlled branch-protection policy-as-code was found.",
	);

	if (hasLocalServiceRequirement) {
		criteria.local_services_setup = contentDecision(
			root,
			[
				...contributorDocs,
				...trackedFiles.filter((file) =>
					/(?:compose(?:\.[^/]+)?\.ya?ml$|package\.json$|Makefile$|Taskfile\.ya?ml$|justfile$)/i.test(
						file,
					),
				),
			],
			/(?:docker\s+compose\s+up|podman\s+compose\s+up|supabase\s+start|\b(?:make|just|task|npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:services?|infra|stack|proxy|backend)\b)/i,
			"Required local services have a documented repository-owned startup command.",
			"A local service or localhost dependency is required, but no reproducible startup command was found.",
		);
	} else {
		criteria.local_services_setup = {
			mode: "not_applicable",
			result: result(
				"skipped",
				"No required local service or localhost dependency was detected.",
			),
		};
	}

	for (const id of ["database_schema", "n_plus_one_detection"]) {
		if (!hasDatabaseSurface) {
			criteria[id] = {
				mode: "not_applicable",
				result: result(
					"skipped",
					"No database or persistence surface was detected in the repository.",
				),
			};
		}
	}
	for (const id of ["api_schema_docs", "dast_scanning"]) {
		if (!hasApiSurface) {
			criteria[id] = {
				mode: "not_applicable",
				result: result(
					"skipped",
					"No HTTP API or web application surface was detected in the repository.",
				),
			};
		}
	}

	const repositoryProfile = {
		files,
		trackedFiles,
		relevantFiles,
		languages,
		applications: applications(files, languages),
		hasEnvironmentUsage,
		hasDatabaseSurface,
		hasApiSurface,
		hasLocalServiceRequirement,
	};
	const definitions = enabledProfileCriteria(selectedProfile);
	if (definitions.length === 0)
		throw new Error("The selected readiness profile has no enabled criteria.");
	const selectedCriteria: Record<string, ReadinessDecision> = {};
	if (isStandardProfile(selectedProfile)) {
		for (const definition of definitions) {
			const decision = criteria[definition.key];
			if (!decision)
				throw new Error(
					`Standard profile references unsupported criterion: ${definition.key}.`,
				);
			selectedCriteria[definition.key] = decision;
		}
	} else {
		for (const definition of definitions) {
			const builtInKey = builtInReadinessRuleKey(definition);
			if (builtInKey) {
				const decision = criteria[builtInKey];
				if (!decision)
					throw new Error(
						`Readiness profile references unsupported built-in criterion: ${builtInKey}.`,
					);
				selectedCriteria[definition.key] = decision;
				continue;
			}
			selectedCriteria[definition.key] = evaluateConfiguredCriterion(
				definition,
				{
					root,
					files,
					trackedFiles,
				},
			);
		}
	}
	const discoveredEvidence = Object.values(selectedCriteria).flatMap(
		(decision) =>
			decision.mode === "semantic"
				? (decision.evidence ?? [])
				: decision.result.evidence,
	);
	return {
		profile: {
			...repositoryProfile,
			relevantFiles: [
				...new Set([...repositoryProfile.relevantFiles, ...discoveredEvidence]),
			].slice(0, 800),
		},
		criteria: selectedCriteria,
		criteriaOrder: definitions.map((criterion) => criterion.key),
		definitions,
		analyzerVersion: selectedProfile.activeVersion.analyzerVersion,
	};
}

export function semanticCriterionIds(plan: ReadinessEvaluationPlan): string[] {
	return plan.criteriaOrder.filter(
		(id) => plan.criteria[id]?.mode === "semantic",
	);
}

export function finalizeReadinessOutput(
	output: AgentReadinessOutput,
	plan: ReadinessEvaluationPlan,
): AgentReadinessOutput {
	const warnings = [...(Array.isArray(output.warnings) ? output.warnings : [])];
	const criteria = Object.fromEntries(
		plan.criteriaOrder.map((id) => {
			const decision = plan.criteria[id];
			if (decision?.mode !== "semantic") return [id, decision?.result];
			const agentResult = output.criteria?.[id];
			if (!agentResult || agentResult.status === "skipped") {
				const definition = plan.definitions.find((entry) => entry.key === id);
				warnings.push(
					`${definition?.name || id} was not judged by the agent and was conservatively scored as failing.`,
				);
				return [
					id,
					result(
						"fail",
						agentResult?.rationale ||
							"The semantic evaluator did not establish this criterion.",
						agentResult?.evidence ?? [],
					),
				];
			}
			return [
				id,
				result(
					agentResult.status === "pass" ? "pass" : "fail",
					agentResult.rationale,
					agentResult.evidence,
				),
			];
		}),
	) as Record<string, ReadinessCriterionResult>;
	const agentRecommendations = Array.isArray(output.recommendations)
		? output.recommendations.filter(
				(recommendation) =>
					!/^Address\s+[A-Z]\.?$/i.test(recommendation.trim()),
			)
		: [];
	const recommendations = [...new Set(agentRecommendations)].slice(0, 3);
	return {
		...output,
		rubricVersion: plan.analyzerVersion,
		languages: plan.profile.languages,
		applications: plan.profile.applications,
		criteria,
		warnings: [
			...new Set(
				warnings.map((warning) =>
					plan.definitions.reduce(
						(message, definition) =>
							message.replaceAll(
								definition.key,
								definition.name || definition.key,
							),
						warning,
					),
				),
			),
		],
		recommendations,
		model: typeof output.model === "string" ? output.model : null,
	};
}

export function readinessPlanPrompt(plan: ReadinessEvaluationPlan): string {
	const semantic = semanticCriterionIds(plan);
	const fixed = Object.fromEntries(
		plan.criteriaOrder
			.filter((id) => plan.criteria[id]?.mode !== "semantic")
			.map((id) => [id, plan.criteria[id]]),
	);
	return JSON.stringify({
		profile: {
			languages: plan.profile.languages,
			applications: plan.profile.applications,
			hasEnvironmentUsage: plan.profile.hasEnvironmentUsage,
			hasDatabaseSurface: plan.profile.hasDatabaseSurface,
			hasApiSurface: plan.profile.hasApiSurface,
			hasLocalServiceRequirement: plan.profile.hasLocalServiceRequirement,
		},
		relevantFiles: plan.profile.relevantFiles,
		semanticCriteria: semantic,
		fixedDecisions: fixed,
	});
}
