import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadinessCriterionConfig } from "@/lib/readiness-profile.js";
import { evaluateConfiguredCriterion } from "@/lib/readiness-rules.js";

const roots: string[] = [];
function repository(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "codev-readiness-rules-"));
	roots.push(root);
	execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), content);
	}
	execFileSync("git", ["add", "."], { cwd: root });
	const trackedFiles = Object.keys(files);
	return { root, files: trackedFiles, trackedFiles };
}

function criterion(
	overrides: Partial<ReadinessCriterionConfig> = {},
): ReadinessCriterionConfig {
	return {
		key: "tests_configured",
		name: "Tests configured",
		category: "Testing",
		description: "Tests should be configured.",
		maturityLevel: 1,
		repositoryScope: "repository",
		enabled: true,
		order: 0,
		passCondition: "A test script exists.",
		evidenceRequirement: "package.json",
		applicability: { kind: "always" },
		evidenceLocators: [
			{ type: "manifest_script", manifest: "package.json", name: "test" },
		],
		decision: { engine: "deterministic", expected: "present" },
		recommendationTemplate: "Add tests.",
		priority: 1,
		...overrides,
	};
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("declarative readiness rules", () => {
	it("evaluates bounded manifest predicates deterministically", () => {
		const inventory = repository({
			"package.json": JSON.stringify({ scripts: { test: "vitest" } }),
		});
		expect(evaluateConfiguredCriterion(criterion(), inventory)).toMatchObject({
			mode: "deterministic",
			result: { status: "pass", evidence: ["package.json"] },
		});
	});

	it("marks N/A only from a failed applicability rule", () => {
		const inventory = repository({ README: "notes" });
		const configured = criterion({
			applicability: {
				kind: "predicate",
				predicate: { type: "tracked_path_exists", path: "src/**" },
			},
		});
		expect(evaluateConfiguredCriterion(configured, inventory)).toMatchObject({
			mode: "not_applicable",
			result: { status: "skipped", numerator: null },
		});
	});

	it("rejects unsafe regex constructs", () => {
		const inventory = repository({ "src/a.ts": "aaaa" });
		const configured = criterion({
			evidenceLocators: [
				{ type: "text_matches", path: "src/**", pattern: "(a+)+$" },
			],
		});
		expect(() => evaluateConfiguredCriterion(configured, inventory)).toThrow(
			/unsupported constructs/,
		);
	});
});
