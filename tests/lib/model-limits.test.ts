import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	CLAUDE_MAX_COMPACT_PCT,
	COMPACT_RESERVED,
	claudeCompactPct,
	claudeWindow,
	compactPct,
	DEFAULT_LIMITS,
	DEFAULT_OUTPUT_TOKENS,
	declaredInput,
	limitsFor,
	limitsFromWindow,
	type ModelLimits,
	outputTokens,
	resetModelLimitsCache,
} from "@/lib/model-limits.js";

let tempDir: string;

function writeCachedLimits(limits: Record<string, ModelLimits>): void {
	const dir = join(tempDir, ".codev-hub");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({ model_limits: limits }),
	);
	// The remote map is read once per process; drop the memo so this write is
	// the one the next limitsFor() call sees.
	resetModelLimitsCache();
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-model-limits-"));
	vi.stubEnv("HOME", tempDir);
	vi.stubEnv("USERPROFILE", tempDir);
	resetModelLimitsCache();
});

afterEach(() => {
	vi.unstubAllEnvs();
	resetModelLimitsCache();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("limitsFor", () => {
	test("returns the table entry for a known model, trigger at 90%", () => {
		expect(limitsFor("MiniMax/MiniMax-M3")).toEqual({
			context: 262144,
			trigger: 235930,
		});
		expect(limitsFor("zai-org/GLM-5.3-Flash")).toEqual({
			context: 262144,
			trigger: 235930,
		});
	});

	test("falls back to the 200K default for an unrecognized model", () => {
		expect(limitsFor("some/model-nobody-has-heard-of")).toEqual(DEFAULT_LIMITS);
	});

	test("MiniMax-M2.7 is covered by the default rather than its own entry", () => {
		// Intentionally absent from the table — the default already describes it.
		expect(limitsFor("MiniMax/MiniMax-M2.7")).toEqual({
			context: 200000,
			trigger: 180000,
		});
	});

	test("a gateway-reported window outranks the table", () => {
		writeCachedLimits({
			"MiniMax/MiniMax-M3": { context: 524288, trigger: 419430 },
		});
		expect(limitsFor("MiniMax/MiniMax-M3")).toEqual({
			context: 524288,
			trigger: 419430,
		});
	});

	test("a model the gateway says nothing about still gets the table entry", () => {
		writeCachedLimits({ "other/model": { context: 12345, trigger: 9876 } });
		expect(limitsFor("zai-org/GLM-5.3-Flash")).toEqual({
			context: 262144,
			trigger: 235930,
		});
	});

	test("an absent cache file is not an error", () => {
		expect(limitsFor("MiniMax/MiniMax-M3")).toEqual({
			context: 262144,
			trigger: 235930,
		});
	});
});

describe("limitsFromWindow", () => {
	test("derives the trigger at 90% of the window", () => {
		expect(limitsFromWindow(1000000)).toEqual({
			context: 1000000,
			trigger: 900000,
		});
		// A non-round window rounds the trigger: 262144 × 0.9 = 235929.6.
		expect(limitsFromWindow(262144)).toEqual({
			context: 262144,
			trigger: 235930,
		});
	});

	test("carries an output cap through when the gateway reports one", () => {
		expect(limitsFromWindow(200000, 8192)).toEqual({
			context: 200000,
			trigger: 180000,
			output: 8192,
		});
	});

	test("omits output entirely when the gateway reports none", () => {
		expect(limitsFromWindow(200000)).not.toHaveProperty("output");
	});
});

describe("compactPct", () => {
	test("expresses the trigger as a whole percentage of the window", () => {
		expect(compactPct({ context: 1000000, trigger: 800000 })).toBe(80);
		expect(compactPct({ context: 200000, trigger: 160000 })).toBe(80);
	});

	test("rounds a trigger that isn't a whole percentage of its window", () => {
		expect(compactPct({ context: 196608, trigger: 167117 })).toBe(85);
	});
});

// Claude Code will not accept an arbitrary window. Its `nc()` resolves the
// window as `Math.min(nativeWindow, envValue)` — 200000 for a model it doesn't
// recognize — and `Rzq` caps the trigger at 80% of that via
// precomputeBufferFraction. Both were verified against the shipped binary.
describe("claudeWindow / claudeCompactPct", () => {
	test("an above-ceiling model is pinned at Claude Code's 200K, not its true window", () => {
		const m3 = limitsFor("MiniMax/MiniMax-M3");
		expect(m3.context).toBe(262144);
		// Writing 262144 would be silently clamped to 200000 anyway.
		expect(claudeWindow(m3)).toBe(200000);
	});

	test("the percentage is taken against the clamped window, not the true one", () => {
		// 235930/262144 would be 90, but 235930/200000 is 118 — the raw ratio is
		// meaningless once the window is clamped, so it must be bounded.
		expect(claudeCompactPct(limitsFor("MiniMax/MiniMax-M3"))).toBe(80);
		// A model already at the ceiling is capped by the same guard: its own
		// 90% target is above Claude Code's 80%.
		expect(claudeCompactPct(DEFAULT_LIMITS)).toBe(80);
	});

	test("never exceeds 80%, which Claude Code's Rzq discards anything above", () => {
		expect(claudeCompactPct({ context: 200000, trigger: 195000 })).toBe(
			CLAUDE_MAX_COMPACT_PCT,
		);
	});

	test("a below-target trigger is still honored", () => {
		// The ceiling is a cap, not a fixed value: asking to compact earlier works.
		expect(claudeCompactPct({ context: 200000, trigger: 100000 })).toBe(50);
	});

	test("never returns 0, which Claude Code's `K > 0` guard would ignore", () => {
		expect(claudeCompactPct({ context: 1000000, trigger: 100 })).toBe(1);
	});

	// The trap: with source "env", Claude Code's `aiK` takes the branch that
	// reads `if (window < 200000) return false` — pinning a smaller window turns
	// auto-compaction OFF rather than tightening it. Omitting the variable
	// leaves source "auto", which skips that gate.
	test("omits the window for a model below the ceiling rather than disabling compaction", () => {
		expect(claudeWindow({ context: 128000, trigger: 100000 })).toBeNull();
		// The percentage still applies, against the model's own window.
		expect(claudeCompactPct({ context: 128000, trigger: 100000 })).toBe(78);
	});

	test("pins exactly at the boundary", () => {
		expect(claudeWindow({ context: 200000, trigger: 160000 })).toBe(200000);
		expect(claudeWindow({ context: 199999, trigger: 160000 })).toBeNull();
	});
});

describe("declaredInput", () => {
	// The whole point of limit.input: OpenCode's trigger is
	// `input − reserved` with ONE global reserve, so input is the only
	// per-model lever. A model whose 90% target + reserve fits its window
	// lands exactly on target; the served models' targets don't, so the
	// clamp pins input at the window — effective triggers stay per-model
	// and never past the ceiling.
	test("declares each model's own input under one shared reserve", () => {
		expect(
			declaredInput({ context: 1000000, trigger: 900000 }) - COMPACT_RESERVED,
		).toBe(900000);
		const m3 = limitsFor("MiniMax/MiniMax-M3");
		expect(declaredInput(m3)).toBe(262144);
		expect(declaredInput(m3) - COMPACT_RESERVED).toBe(222144);
		expect(declaredInput(DEFAULT_LIMITS)).toBe(200000);
		expect(declaredInput(DEFAULT_LIMITS) - COMPACT_RESERVED).toBe(160000);
	});

	test("clamps to the true window so the budget is never overstated", () => {
		// trigger + reserved (195000) exceeds the window (180000): declaring it
		// would let a session run past the model's real ceiling before
		// compacting, so the window wins and the trigger only moves earlier.
		const tight: ModelLimits = { context: 180000, trigger: 155000 };
		expect(declaredInput(tight)).toBe(180000);
		expect(declaredInput(tight) - COMPACT_RESERVED).toBeLessThan(155000);
	});
});

describe("outputTokens", () => {
	test("defaults when the model declares no output cap", () => {
		expect(outputTokens({ context: 200000, trigger: 160000 })).toBe(
			DEFAULT_OUTPUT_TOKENS,
		);
	});

	test("prefers the model's own cap", () => {
		expect(
			outputTokens({ context: 200000, trigger: 160000, output: 8192 }),
		).toBe(8192);
	});
});
