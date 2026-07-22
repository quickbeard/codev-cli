import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ReadinessCriterionResult } from "@/lib/readiness-contract.js";
import type {
	ReadinessCriterionConfig,
	ReadinessProfile,
} from "@/lib/readiness-profile.js";

const MAX_RULE_DEPTH = 8;
const MAX_RULE_NODES = 100;
const MAX_PATTERN_LENGTH = 300;
const MAX_FILES_PER_LOCATOR = 200;
const MAX_EVIDENCE = 8;
const MAX_TEXT_BYTES = 256_000;
const MAX_TOTAL_TEXT_BYTES = 2_000_000;

type Json = Record<string, unknown>;

export interface DeclarativeInventory {
	root: string;
	files: string[];
	trackedFiles: string[];
}

export type ConfiguredDecision =
	| { mode: "semantic"; reason: string; evidence: string[] }
	| { mode: "not_applicable"; result: ReadinessCriterionResult }
	| { mode: "deterministic"; result: ReadinessCriterionResult };

function record(value: unknown): Json | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: null;
}

function kind(value: Json): string | undefined {
	return typeof value.kind === "string" ? value.kind : undefined;
}

function boundedString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value || value.length > MAX_PATTERN_LENGTH)
		throw new Error(`Readiness rule ${field} is invalid.`);
	return value;
}

function strings(value: Json, singular: string, plural: string): string[] {
	const raw = Array.isArray(value[plural])
		? value[plural]
		: value[singular] === undefined
			? []
			: [value[singular]];
	if (
		raw.length === 0 ||
		raw.length > 20 ||
		raw.some((entry) => typeof entry !== "string")
	)
		throw new Error(`Readiness rule ${plural} is invalid.`);
	return (raw as string[]).map((entry) => boundedString(entry, plural));
}

function globRegex(glob: string): RegExp {
	let source = "^";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index] ?? "";
		if (char === "*") {
			if (glob[index + 1] === "*") {
				index++;
				source += ".*";
			} else source += "[^/]*";
		} else if (char === "?") source += "[^/]";
		else source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	}
	return new RegExp(`${source}$`);
}

function matchesGlobs(files: string[], patterns: string[]): string[] {
	const compiled = patterns.map(globRegex);
	return files
		.filter((file) => compiled.some((pattern) => pattern.test(file)))
		.slice(0, MAX_FILES_PER_LOCATOR);
}

function inside(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeText(
	inventory: DeclarativeInventory,
	file: string,
	budget: { bytes: number },
): string {
	try {
		const target = resolve(inventory.root, file);
		if (!inside(inventory.root, target) || lstatSync(target).isSymbolicLink())
			return "";
		if (!inside(realpathSync(inventory.root), realpathSync(target))) return "";
		const content = readFileSync(target);
		if (
			content.byteLength > MAX_TEXT_BYTES ||
			budget.bytes + content.byteLength > MAX_TOTAL_TEXT_BYTES ||
			content.includes(0)
		)
			return "";
		budget.bytes += content.byteLength;
		return content.toString("utf8");
	} catch {
		return "";
	}
}

function safeRegex(pattern: string, flags: string): RegExp {
	boundedString(pattern, "pattern");
	if (!/^[im]*$/.test(flags))
		throw new Error("Readiness rule flags are invalid.");
	// Reject constructs that are unnecessary for configuration matching and are
	// common sources of catastrophic backtracking or surprising cross-file logic.
	if (/\\[1-9]|\(\?[=!<]|\([^)]*[+*][^)]*\)[+*{]/.test(pattern))
		throw new Error("Readiness rule regex uses unsupported constructs.");
	return new RegExp(pattern, flags);
}

function nested(value: unknown, path: string): unknown {
	let current = value;
	for (const part of path.split(".")) {
		const item = record(current);
		if (!item || !(part in item)) return undefined;
		current = item[part];
	}
	return current;
}

function predicateMatches(
	value: unknown,
	inventory: DeclarativeInventory,
	budget: { bytes: number },
): string[] {
	const predicate = record(value);
	if (!predicate || typeof predicate.type !== "string")
		throw new Error("Readiness predicate is invalid.");
	switch (predicate.type) {
		case "tracked_path_exists":
			return matchesGlobs(
				inventory.trackedFiles,
				predicate.path === undefined
					? strings(predicate, "pattern", "patterns")
					: [boundedString(predicate.path, "path")],
			);
		case "text_matches": {
			const candidates = matchesGlobs(
				inventory.trackedFiles,
				predicate.path === undefined
					? strings(predicate, "filePattern", "filePatterns")
					: [boundedString(predicate.path, "path")],
			);
			const regex = safeRegex(
				boundedString(predicate.pattern, "pattern"),
				typeof predicate.flags === "string" ? predicate.flags : "",
			);
			return candidates.filter((file) =>
				regex.test(safeText(inventory, file, budget)),
			);
		}
		case "manifest_script":
		case "manifest_dependency": {
			const name = boundedString(predicate.name, "name");
			const manifests =
				predicate.manifest === undefined
					? inventory.trackedFiles.filter((file) =>
							/(^|\/)package\.json$/.test(file),
						)
					: matchesGlobs(inventory.trackedFiles, [
							boundedString(predicate.manifest, "manifest"),
						]);
			return manifests
				.filter((file) => {
					try {
						const manifest = JSON.parse(
							safeText(inventory, file, budget),
						) as Json;
						if (predicate.type === "manifest_script")
							return typeof record(manifest.scripts)?.[name] === "string";
						return [
							"dependencies",
							"devDependencies",
							"peerDependencies",
							"optionalDependencies",
						].some((group) => name in (record(manifest[group]) ?? {}));
					} catch {
						return false;
					}
				})
				.slice(0, MAX_FILES_PER_LOCATOR);
		}
		case "manifest_setting": {
			const manifest = boundedString(
				predicate.manifest ?? predicate.filePattern,
				"manifest",
			);
			const setting = boundedString(
				predicate.setting ?? predicate.path,
				"path",
			);
			return matchesGlobs(inventory.trackedFiles, [manifest])
				.filter((file) => {
					try {
						const value = nested(
							JSON.parse(safeText(inventory, file, budget)),
							setting,
						);
						const hasExpected = "value" in predicate || "equals" in predicate;
						const expected =
							"value" in predicate ? predicate.value : predicate.equals;
						return hasExpected
							? JSON.stringify(value) === JSON.stringify(expected)
							: value !== undefined;
					} catch {
						return false;
					}
				})
				.slice(0, MAX_FILES_PER_LOCATOR);
		}
		default:
			throw new Error(`Unsupported readiness predicate: ${predicate.type}.`);
	}
}

function evaluateRule(
	value: unknown,
	inventory: DeclarativeInventory,
	budget: { nodes: number; bytes: number },
	depth = 0,
): boolean {
	if (++budget.nodes > MAX_RULE_NODES || depth > MAX_RULE_DEPTH)
		throw new Error("Readiness applicability rule exceeds safe bounds.");
	const rule = record(value);
	if (!rule) throw new Error("Readiness applicability rule is invalid.");
	switch (kind(rule)) {
		case "always":
			return true;
		case "predicate":
			return (
				predicateMatches(rule.predicate ?? rule, inventory, budget).length > 0
			);
		case "all":
		case "any": {
			if (
				!Array.isArray(rule.rules) ||
				rule.rules.length === 0 ||
				rule.rules.length > 20
			)
				throw new Error("Readiness applicability composition is invalid.");
			const values = rule.rules.map((child) =>
				evaluateRule(child, inventory, budget, depth + 1),
			);
			return kind(rule) === "all"
				? values.every(Boolean)
				: values.some(Boolean);
		}
		case "not":
			return !evaluateRule(rule.rule, inventory, budget, depth + 1);
		case "minimum_match": {
			const minimum = rule.minimum ?? rule.count;
			if (!Array.isArray(rule.rules) || !Number.isSafeInteger(minimum))
				throw new Error("Readiness minimum-match rule is invalid.");
			const count = rule.rules.filter((child) =>
				evaluateRule(child, inventory, budget, depth + 1),
			).length;
			return count >= (minimum as number);
		}
		default:
			throw new Error(
				`Unsupported readiness applicability kind: ${String(kind(rule))}.`,
			);
	}
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
		evidence: evidence.slice(0, MAX_EVIDENCE),
	};
}

export function evaluateConfiguredCriterion(
	criterion: ReadinessCriterionConfig,
	inventory: DeclarativeInventory,
): ConfiguredDecision {
	const budget = { nodes: 0, bytes: 0 };
	if (!evaluateRule(criterion.applicability, inventory, budget))
		return {
			mode: "not_applicable",
			result: result(
				"skipped",
				`The applicability rule for ${criterion.name} did not match.`,
			),
		};
	const locatorEvidence = criterion.evidenceLocators.map((locator) =>
		predicateMatches(locator, inventory, budget),
	);
	const evidence = [...new Set(locatorEvidence.flat())].slice(0, MAX_EVIDENCE);
	const decision = record(criterion.decision);
	const engine =
		typeof decision?.engine === "string" ? decision.engine : undefined;
	if (engine === "semantic")
		return {
			mode: "semantic",
			reason:
				typeof decision?.instructions === "string"
					? decision.instructions
					: criterion.passCondition,
			evidence,
		};
	if (engine !== "deterministic")
		throw new Error(
			`Unsupported readiness decision engine for ${criterion.key}.`,
		);
	const match = decision?.match;
	const matched = locatorEvidence.filter(
		(entries) => entries.length > 0,
	).length;
	const minimum = decision?.minimum;
	const passed =
		match === "none"
			? matched === 0
			: match === "all"
				? locatorEvidence.length > 0 && matched === locatorEvidence.length
				: match === "minimum"
					? matched >= (minimum as number)
					: matched > 0;
	const rationale = passed
		? typeof decision?.passRationale === "string"
			? decision.passRationale
			: criterion.passCondition
		: typeof decision?.failRationale === "string"
			? decision.failRationale
			: `Required evidence was not established for ${criterion.name}.`;
	return {
		mode: "deterministic",
		result: result(passed ? "pass" : "fail", rationale, evidence),
	};
}

function validateConfiguredCriterion(
	criterion: ReadinessCriterionConfig,
	inventory: DeclarativeInventory,
): void {
	const budget = { nodes: 0, bytes: 0 };
	evaluateRule(criterion.applicability, inventory, budget);
	for (const locator of criterion.evidenceLocators)
		predicateMatches(locator, inventory, budget);
	const engine = record(criterion.decision)?.engine;
	if (engine === "builtin") {
		const ruleKey = record(criterion.decision)?.ruleKey;
		if (ruleKey !== criterion.key)
			throw new Error(
				`Readiness built-in rule key for ${criterion.key} is invalid.`,
			);
		return;
	}
	if (engine !== "deterministic" && engine !== "semantic")
		throw new Error(
			`Unsupported readiness decision engine for ${criterion.key}.`,
		);
	if (engine === "deterministic") {
		const decision = record(criterion.decision);
		const match = decision?.match;
		if (
			match !== "any" &&
			match !== "all" &&
			match !== "none" &&
			match !== "minimum"
		)
			throw new Error(
				`Readiness deterministic match mode for ${criterion.key} is invalid.`,
			);
		if (criterion.evidenceLocators.length === 0)
			throw new Error(
				`Readiness deterministic locators for ${criterion.key} are required.`,
			);
		const minimum = decision?.minimum;
		if (
			match === "minimum" &&
			(!Number.isSafeInteger(minimum) ||
				(minimum as number) < 1 ||
				(minimum as number) > criterion.evidenceLocators.length)
		)
			throw new Error(
				`Readiness deterministic minimum for ${criterion.key} is invalid.`,
			);
	}
}

export function validateProfileRules(profile: ReadinessProfile): void {
	const inventory: DeclarativeInventory = {
		root: process.cwd(),
		files: [],
		trackedFiles: [],
	};
	for (const criterion of profile.activeVersion.definition.criteria) {
		if (!criterion.enabled) continue;
		// Validation happens with an empty inventory and still walks every rule and
		// locator, compiling all patterns before repository evaluation begins.
		validateConfiguredCriterion(criterion, inventory);
	}
}
