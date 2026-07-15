import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentReadinessOutput,
	READINESS_CRITERION_IDS,
	READINESS_RUBRIC_VERSION,
	summarizeReadiness,
} from "@/lib/readiness-contract.js";
import {
	buildReadinessEvaluationPlan,
	finalizeReadinessOutput,
	semanticCriterionIds,
} from "@/lib/readiness-plan.js";

const roots: string[] = [];

function repository(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "codev-readiness-plan-"));
	roots.push(root);
	execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), content);
	}
	execFileSync("git", ["add", "."], { cwd: root });
	return root;
}

function agentOutput(
	status: "pass" | "fail" | "skipped",
): AgentReadinessOutput {
	return {
		rubricVersion: READINESS_RUBRIC_VERSION,
		languages: ["Imaginary"],
		applications: [{ path: ".", description: "Agent guess", languages: [] }],
		criteria: Object.fromEntries(
			READINESS_CRITERION_IDS.map((id) => [
				id,
				{
					status,
					numerator: status === "skipped" ? null : status === "pass" ? 3 : 0,
					denominator: status === "skipped" ? 1 : 3,
					rationale: `Agent marked ${id} ${status}.`,
					evidence: [],
				},
			]),
		),
		warnings: [],
		recommendations: ["First", "Second"],
		model: "fixture",
	};
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("readiness evaluation plan", () => {
	it("recognizes env template naming variants only when env configuration is relevant", () => {
		const root = repository({
			"package.json": '{"scripts":{"start":"node src/index.js"}}',
			"src/index.js": "console.log(process.env.PORT);",
			".env.local.example": "PORT=3000\n",
		});

		const plan = buildReadinessEvaluationPlan(root);

		expect(plan.profile.hasEnvironmentUsage).toBe(true);
		expect(plan.criteria.env_template).toMatchObject({
			mode: "deterministic",
			result: { status: "pass", evidence: [".env.local.example"] },
		});
	});

	it("does not penalize a repository that has no environment-variable requirement", () => {
		const root = repository({
			"Cargo.toml": '[package]\nname = "pure-library"\n',
			"src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b }",
		});

		const plan = buildReadinessEvaluationPlan(root);

		expect(plan.criteria.env_template).toMatchObject({
			mode: "not_applicable",
			result: { status: "skipped", numerator: null },
		});
	});

	it("uses exact cross-platform repository conventions for presence checks", () => {
		const root = repository({
			"CLAUDE.md": "# Agent instructions",
			"README.md": "# Fixture",
			".github/CODEOWNERS": "* @team",
			".github/ISSUE_TEMPLATE/bug.yml": "name: Bug",
			".gitlab/merge_request_templates/default.md": "Checklist",
			".devcontainer/devcontainer.json": "{}",
			".agents/skills/review/SKILL.md": "---\nname: review\n---",
		});

		const plan = buildReadinessEvaluationPlan(root);

		for (const id of [
			"agents_md",
			"readme",
			"codeowners",
			"issue_templates",
			"pr_templates",
			"devcontainer",
			"skills",
		]) {
			expect(plan.criteria[id]).toMatchObject({
				mode: "deterministic",
				result: { status: "pass" },
			});
		}
	});

	it("scores tracked validation hooks and instruction validation deterministically", () => {
		const root = repository({
			"AGENTS.md": "# Agent instructions",
			".husky/pre-commit": "pnpm lint && pnpm test",
			".github/workflows/agents.yml":
				"steps:\n  - run: node scripts/validate-agents.js AGENTS.md\n",
		});

		const plan = buildReadinessEvaluationPlan(root);

		expect(plan.criteria.pre_commit_hooks).toMatchObject({
			mode: "deterministic",
			result: { status: "pass", evidence: [".husky/pre-commit"] },
		});
		expect(plan.criteria.agents_md_validation).toMatchObject({
			mode: "deterministic",
			result: { status: "pass" },
		});
		expect(plan.profile.relevantFiles).toContain(
			".github/workflows/agents.yml",
		);
	});

	it("does not confuse general linting with specialized repository tooling", () => {
		const root = repository({
			"package.json":
				'{"scripts":{"check":"biome check","setup":"pnpm install"},"devDependencies":{"@biomejs/biome":"1"}}',
			"biome.json": '{"linter":{"enabled":true,"rules":{"recommended":true}}}',
			"README.md": "Run `pnpm setup` to bootstrap the repository.",
		});

		const plan = buildReadinessEvaluationPlan(root);

		expect(plan.criteria.single_command_setup).toMatchObject({
			mode: "deterministic",
			result: { status: "pass" },
		});
		expect(plan.criteria.dead_code_detection).toMatchObject({
			mode: "deterministic",
			result: { status: "pass" },
		});
		for (const id of [
			"cyclomatic_complexity",
			"duplicate_code_detection",
			"unused_dependencies_detection",
		]) {
			expect(plan.criteria[id]).toMatchObject({
				mode: "deterministic",
				result: { status: "fail" },
			});
		}
	});

	it("requires real VCS commands and branch policy rather than CI mentions", () => {
		const root = repository({
			"README.md": "GitHub Actions runs on every pull request.",
			".github/workflows/test.yml":
				"jobs: { test: { runs-on: ubuntu-latest } }",
		});
		const configured = repository({
			"CONTRIBUTING.md": "Use `gh pr create` after `git push`.",
			"infra/github.tf":
				'resource "github_branch_protection" "main" { required_status_checks { strict = true } }',
		});

		expect(
			buildReadinessEvaluationPlan(root).criteria.vcs_cli_tools,
		).toMatchObject({ result: { status: "fail" } });
		expect(
			buildReadinessEvaluationPlan(root).criteria.branch_protection,
		).toMatchObject({ result: { status: "fail" } });
		expect(
			buildReadinessEvaluationPlan(configured).criteria.vcs_cli_tools,
		).toMatchObject({ result: { status: "pass" } });
		expect(
			buildReadinessEvaluationPlan(configured).criteria.branch_protection,
		).toMatchObject({ result: { status: "pass" } });
	});

	it("evaluates flow documentation and ecosystem-specific ignore coverage", () => {
		const complete = buildReadinessEvaluationPlan(
			repository({
				"package.json": '{"scripts":{"build":"tsc"}}',
				"src/index.ts": "console.log(process.env.PORT);",
				"AGENTS.md":
					"## Layered architecture\n`src/index.ts` dispatches to `components/`, then `lib/` owns backend API calls.",
				".gitignore": "node_modules/\ndist/\n.env*\n!.env.example\n",
			}),
		);
		const incomplete = buildReadinessEvaluationPlan(
			repository({
				"pyproject.toml": "[project]\nname = 'fixture'\n",
				"README.md": "# Fixture\nA small project.",
				".gitignore": "__pycache__/\n",
			}),
		);

		expect(complete.criteria.service_flow_documented).toMatchObject({
			mode: "deterministic",
			result: { status: "pass" },
		});
		expect(complete.criteria.gitignore_comprehensive).toMatchObject({
			mode: "deterministic",
			result: { status: "pass" },
		});
		expect(incomplete.criteria.service_flow_documented).toMatchObject({
			result: { status: "fail" },
		});
		expect(incomplete.criteria.gitignore_comprehensive).toMatchObject({
			result: { status: "fail" },
		});
	});

	it("makes evaluated-count independent of agent skip behavior", () => {
		const root = repository({
			"README.md": "# Fixture",
			"package.json": '{"scripts":{"test":"vitest"}}',
			"src/index.ts": "export const value = 1;",
		});
		const plan = buildReadinessEvaluationPlan(root);
		const semanticCount = semanticCriterionIds(plan).length;

		const skipped = finalizeReadinessOutput(agentOutput("skipped"), plan);
		const passed = finalizeReadinessOutput(agentOutput("pass"), plan);

		expect(summarizeReadiness(skipped.criteria).criteriaTotal).toBe(
			summarizeReadiness(passed.criteria).criteriaTotal,
		);
		expect(
			Object.values(skipped.criteria).filter((item) => item.status === "fail")
				.length,
		).toBeGreaterThanOrEqual(semanticCount);
		expect(skipped.languages).toEqual(["TypeScript"]);
		expect(skipped.applications).toEqual(passed.applications);
	});

	it("only skips database and API checks after high-confidence absence", () => {
		const plain = buildReadinessEvaluationPlan(
			repository({ "README.md": "# Notes" }),
		);
		const service = buildReadinessEvaluationPlan(
			repository({
				"package.json": '{"dependencies":{"express":"1","prisma":"1"}}',
				"prisma/schema.prisma": "model User { id Int @id }",
				"src/routes/users.ts": "export const route = true;",
			}),
		);

		expect(plain.criteria.database_schema?.mode).toBe("not_applicable");
		expect(plain.criteria.api_schema_docs?.mode).toBe("not_applicable");
		expect(plain.criteria.local_services_setup?.mode).toBe("not_applicable");
		expect(service.criteria.database_schema?.mode).toBe("semantic");
		expect(service.criteria.api_schema_docs?.mode).toBe("semantic");
	});

	it("requires a startup command only when a local service is detected", () => {
		const missingSetup = buildReadinessEvaluationPlan(
			repository({
				"src/config.ts": 'export const url = "http://localhost:8787";',
			}),
		);
		const documentedSetup = buildReadinessEvaluationPlan(
			repository({
				"src/config.ts": 'export const url = "http://localhost:5432";',
				"README.md": "Run `docker compose up` to start local services.",
				"compose.yml": "services: { db: { image: postgres } }",
			}),
		);

		expect(missingSetup.criteria.local_services_setup).toMatchObject({
			mode: "deterministic",
			result: { status: "fail" },
		});
		expect(documentedSetup.criteria.local_services_setup).toMatchObject({
			mode: "deterministic",
			result: { status: "pass" },
		});
	});
});
