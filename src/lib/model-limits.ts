import { loadModelLimits } from "@/lib/auth.js";

// Per-model context windows and auto-compaction triggers.
//
// Every agent CoDev configures needs to be told the window of the model it's
// talking to — the gateway serves custom models none of them recognize, so
// each would otherwise guess (Codex assumes 272K, OpenCode assumes 0, which
// disables compaction outright). This module is the single source of truth for
// those numbers; the four writers in lib/configure.ts translate them into each
// agent's own knob and hold no window constants of their own.

export interface ModelLimits {
	// The model's true window. Written verbatim wherever an agent wants "how big
	// is this model" — including OpenCode's `limit.context`, which drives the
	// TUI's "% context used" gauge, so understating it here would misreport
	// every session.
	context: number;
	// Where auto-compaction should fire: always COMPACT_PCT of the window (see
	// limitsFromWindow), though a cached gateway-reported entry carries the
	// number it was derived with.
	trigger: number;
	// Max output tokens. Absent ⇒ DEFAULT_OUTPUT_TOKENS.
	output?: number;
}

// Max output tokens advertised to agents that require one alongside a window.
export const DEFAULT_OUTPUT_TOKENS = 65536;

// OpenCode's `compaction.reserved` — a single global token buffer, with no
// per-model variant in its config schema. See declaredInput() for how a shared
// reserve still yields exact per-model triggers.
export const COMPACT_RESERVED = 40000;

// The trigger is always this share of the window, whatever its source — the
// table, the default, or a gateway-reported window.
export const COMPACT_PCT = 90;

// Unrecognized models are treated as 200K-class. Chosen over the older 196608
// default because it matches the smaller of the two models actually served,
// and because guessing low is the safe direction: too small a window wastes
// capacity, too large overruns the model and 400s mid-session.
const DEFAULT_WINDOW = 200000;

export const DEFAULT_LIMITS: ModelLimits = limitsFromWindow(DEFAULT_WINDOW);

// Known gateway models' context windows. Keyed by the exact id `/v1/models`
// reports, which is what lands in every agent config.
//
// M3's and GLM-5.3-Flash's windows are capped at 262144 on the current
// deployment (the models support more, the gateway's resources don't). Models
// served at the 200K default are deliberately absent: DEFAULT_WINDOW already
// describes them correctly, and an entry that merely restates the default is
// one more thing to keep in sync.
const TABLE: Record<string, number> = {
	"MiniMax/MiniMax-M3": 262144,
	"zai-org/GLM-5.3-Flash": 262144,
};

// Windows reported by the gateway, cached in auth.json by the model-choice
// step. Read once per process: configure* runs several times per command (one
// call per selected agent, and once per model in the OpenCode models map) and
// none of them can change the file mid-run.
let remoteCache: Record<string, ModelLimits> | null | undefined;

function remoteLimits(): Record<string, ModelLimits> | null {
	if (remoteCache === undefined) remoteCache = loadModelLimits();
	return remoteCache;
}

// Test seam: lets a test install (or clear) the remote map without writing
// auth.json and without the once-per-process cache leaking across cases.
export function resetModelLimitsCache(): void {
	remoteCache = undefined;
}

// Resolve one model's limits. Precedence is remote → table → default: the
// gateway is authoritative about its own models when it says anything at all,
// and the table exists to carry the models it currently reports nothing for.
export function limitsFor(modelId: string): ModelLimits {
	const remote = remoteLimits()?.[modelId];
	if (remote) return remote;
	const window = TABLE[modelId];
	return window ? limitsFromWindow(window) : DEFAULT_LIMITS;
}

// Turn a context window into full limits, wherever the window came from.
// Exported for backend.ts, which has the raw
// max_input_tokens/max_output_tokens and no opinion about where the trigger
// belongs.
export function limitsFromWindow(
	context: number,
	output?: number,
): ModelLimits {
	return {
		context,
		trigger: Math.round((context * COMPACT_PCT) / 100),
		...(output ? { output } : {}),
	};
}

// Claude Code takes a window plus a percentage, so the trigger is expressed as
// a share of the window. Integer percent, so a trigger that isn't a whole
// percentage of its window lands within half a percent of the intent.
export function compactPct(limits: ModelLimits): number {
	return Math.round((limits.trigger / limits.context) * 100);
}

// Claude Code's native window for a model it doesn't recognize — which is every
// model the gateway serves. From its `nc()`: the window is
// `Math.min(nativeWindow, envValue)`, so CLAUDE_CODE_AUTO_COMPACT_WINDOW can
// only ever SHRINK the window, never raise it. A 1M-token model is therefore a
// 200000-token model as far as Claude Code is concerned, and there is no way to
// tell it otherwise (CLAUDE_CODE_MAX_CONTEXT_TOKENS is read only when
// DISABLE_COMPACT is set, which turns compaction off).
export const CLAUDE_MAX_WINDOW = 200000;

// Claude Code caps its own trigger at 80% of the effective window:
// `Rzq = Math.min(T − round(T × precomputeBufferFraction), qB6(T, opts))`, with
// precomputeBufferFraction defaulting to 0.2. A percentage above this is inert
// — the Math.min discards it — so 80 is the highest reachable trigger, not a
// preference.
export const CLAUDE_MAX_COMPACT_PCT = 80;

// The value for CLAUDE_CODE_AUTO_COMPACT_WINDOW, or null to omit the variable.
//
// Below CLAUDE_MAX_WINDOW the variable is actively harmful. Setting it makes
// `nc()` report `source: "env"`, which puts `aiK` on the branch that reads
// `if (window < 200000) return false` — auto-compaction stops firing at all.
// Omitting it leaves the source as "auto", which skips that gate and already
// resolves to the same 200000 window. So we pin only when the pin is a no-op
// against Claude Code's own default, and stay out of the way otherwise.
export function claudeWindow(limits: ModelLimits): number | null {
	return limits.context >= CLAUDE_MAX_WINDOW ? CLAUDE_MAX_WINDOW : null;
}

// The trigger percentage, taken against the window Claude Code will actually
// use rather than the model's true one — for a 1M model those differ by 5x, and
// a percentage of the true window would ask for a trigger beyond the clamped
// ceiling. Bounded by CLAUDE_MAX_COMPACT_PCT above and 1 below (0 or a negative
// value fails Claude Code's `K > 0` guard and would be ignored outright).
export function claudeCompactPct(limits: ModelLimits): number {
	const window = claudeWindow(limits) ?? limits.context;
	const pct = Math.round((limits.trigger / window) * 100);
	return Math.min(Math.max(pct, 1), CLAUDE_MAX_COMPACT_PCT);
}

// OpenCode's trigger is `limit.input − compaction.reserved`, falling back to
// `limit.context − maxOutputTokens` when `limit.input` is absent — in which
// case `reserved` is computed and then discarded. So `input` is what makes the
// reserve authoritative, and it is the only per-model lever over a trigger that
// otherwise shares one global reserve across every model in the config.
//
// Solving `input − reserved = trigger` gives `input = trigger + reserved`, which
// lands each model's trigger exactly on target regardless of what the others
// need. `context` stays truthful.
//
// Clamped to the true window: `trigger + reserved` above `context` would
// overstate the budget and let a session run past the model's real ceiling
// before compacting. Clamping can only move a trigger earlier, never later, so
// a bad table entry degrades into early compaction rather than 400s.
export function declaredInput(limits: ModelLimits): number {
	return Math.min(limits.trigger + COMPACT_RESERVED, limits.context);
}

export function outputTokens(limits: ModelLimits): number {
	return limits.output ?? DEFAULT_OUTPUT_TOKENS;
}
