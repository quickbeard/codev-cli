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
		decision: { engine: "deterministic", match: "any" },
		priority: 1,
		...overrides,
	};
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("declarative readiness rules", () => {
	it("uses useful default messages when optional rationale text is empty", () => {
		const inventory = repository({
			"package.json": JSON.stringify({ scripts: { test: "vitest" } }),
		});
		const configured = criterion({
			passCondition: "",
			decision: {
				engine: "deterministic",
				match: "any",
				passRationale: "",
				failRationale: "",
			},
		});
		expect(evaluateConfiguredCriterion(configured, inventory)).toMatchObject({
			mode: "deterministic",
			result: {
				status: "pass",
				rationale: "Required evidence was found for Tests configured.",
			},
		});
	});

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

	it.each([
		"(a|a)*$",
		"(?:a|a)*$",
		"(x|xx)+y",
	])("rejects ambiguous alternation regex %s", (pattern) => {
		const inventory = repository({ "src/a.ts": "a".repeat(40) });
		const configured = criterion({
			evidenceLocators: [{ type: "text_matches", path: "src/**", pattern }],
		});
		expect(() => evaluateConfiguredCriterion(configured, inventory)).toThrow(
			"unsupported constructs",
		);
	});

	it("passes an absence check when prohibited evidence is missing", () => {
		const inventory = repository({ README: "notes" });
		const configured = criterion({
			evidenceLocators: [{ type: "tracked_path_exists", path: ".env" }],
			decision: { engine: "deterministic", match: "none" },
		});
		expect(evaluateConfiguredCriterion(configured, inventory)).toMatchObject({
			mode: "deterministic",
			result: { status: "pass", evidence: [] },
		});
	});

	it("combines locator results with any, all, and minimum policies", () => {
		const inventory = repository({
			"package.json": JSON.stringify({ scripts: { test: "vitest" } }),
		});
		const evidenceLocators = [
			{
				type: "manifest_script" as const,
				manifest: "package.json",
				name: "test",
			},
			{
				type: "manifest_script" as const,
				manifest: "package.json",
				name: "lint",
			},
		];
		expect(
			evaluateConfiguredCriterion(
				criterion({
					evidenceLocators,
					decision: { engine: "deterministic", match: "any" },
				}),
				inventory,
			),
		).toMatchObject({ result: { status: "pass" } });
		expect(
			evaluateConfiguredCriterion(
				criterion({
					evidenceLocators,
					decision: { engine: "deterministic", match: "all" },
				}),
				inventory,
			),
		).toMatchObject({ result: { status: "fail" } });
		expect(
			evaluateConfiguredCriterion(
				criterion({
					evidenceLocators,
					decision: { engine: "deterministic", match: "minimum", minimum: 1 },
				}),
				inventory,
			),
		).toMatchObject({ result: { status: "pass" } });
	});

	it("compares typed manifest setting values without string coercion", () => {
		const inventory = repository({
			"package.json": JSON.stringify({ private: true, engines: { node: 22 } }),
		});
		const booleanSetting = criterion({
			evidenceLocators: [
				{
					type: "manifest_setting",
					manifest: "package.json",
					path: "private",
					value: true,
				},
			],
		});
		const numberSetting = criterion({
			evidenceLocators: [
				{
					type: "manifest_setting",
					manifest: "package.json",
					path: "engines.node",
					value: 22,
				},
			],
		});
		expect(
			evaluateConfiguredCriterion(booleanSetting, inventory),
		).toMatchObject({ result: { status: "pass" } });
		expect(evaluateConfiguredCriterion(numberSetting, inventory)).toMatchObject(
			{ result: { status: "pass" } },
		);
	});
});
