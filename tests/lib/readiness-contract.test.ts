import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as configure from "@/lib/configure.js";
import { gatewayToolForReadiness } from "@/lib/readiness.js";
import {
	activityFromLine,
	assertReadinessPrerequisites,
	buildAgentCommand,
	buildReadinessPrompt,
	claudeReadinessEnvOverrides,
	extractAgentOutput,
	openCodeReadinessConfig,
	openCodeStructuredOutputInstruction,
	providerFailureFromLine,
	readinessProcessEnv,
} from "@/lib/readiness-agent.js";
import { readinessRuntimeConfig } from "@/lib/readiness-config.js";
import {
	type AgentReadinessOutput,
	normalizeReadinessEvidence,
	READINESS_CRITERION_IDS,
	READINESS_RUBRIC_VERSION,
	readinessJsonSchema,
	summarizeReadiness,
	validateReadinessOutput,
} from "@/lib/readiness-contract.js";

// assertReadinessPrerequisites() treats Codex as usable when a real `codex`
// binary is on PATH, probed via spawnSync("codex", ["--version"]). CI runners
// don't install codex, so mock the probe to keep that check deterministic:
// `codex` reports available (status 0); anything else reports unavailable.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync: vi.fn((command: string) => ({
			status: command === "codex" ? 0 : 1,
			signal: null,
			output: [],
			pid: 0,
			stdout: Buffer.from(""),
			stderr: Buffer.from(""),
		})),
	};
});

function validOutput(): AgentReadinessOutput {
	return {
		rubricVersion: READINESS_RUBRIC_VERSION,
		languages: ["TypeScript"],
		applications: [
			{ path: ".", description: "CoDev CLI", languages: ["TypeScript"] },
		],
		criteria: Object.fromEntries(
			READINESS_CRITERION_IDS.map((id) => [
				id,
				{
					status: "skipped",
					numerator: null,
					denominator: 1,
					rationale: "Not established from this fixture.",
					evidence: [],
				},
			]),
		),
		warnings: [],
		recommendations: ["Add a validated check.", "Document the workflow."],
		model: null,
	};
}

describe("readiness contract", () => {
	it("accepts a complete versioned report", () => {
		expect(validateReadinessOutput(validOutput(), process.cwd())).toEqual([]);
	});

	it("rejects missing criteria and evidence outside the repository", () => {
		const output = validOutput();
		delete output.criteria[READINESS_CRITERION_IDS[0] ?? ""];
		const second = READINESS_CRITERION_IDS[1] ?? "";
		output.criteria[second] = {
			status: "pass",
			numerator: 1,
			denominator: 1,
			rationale: "Found.",
			evidence: ["../outside.txt"],
		};
		const errors = validateReadinessOutput(output, process.cwd());
		expect(errors.some((error) => error.includes("Missing criterion"))).toBe(
			true,
		);
		expect(errors.some((error) => error.includes("missing evidence"))).toBe(
			true,
		);
	});

	it("keeps existing directory evidence and removes invalid evidence locally", () => {
		const output = validOutput();
		const id = READINESS_CRITERION_IDS[0] ?? "";
		output.criteria[id] = {
			status: "fail",
			numerator: 0,
			denominator: 1,
			rationale: "No matching automation was found.",
			evidence: ["src/", ".missing-readiness-directory/", "../outside.txt"],
		};

		const normalized = normalizeReadinessEvidence(output, process.cwd());

		expect(normalized.criteria[id]?.evidence).toEqual(["src/"]);
		expect(output.criteria[id]?.evidence).toHaveLength(3);
		expect(validateReadinessOutput(normalized, process.cwd())).toEqual([]);
	});

	it("excludes skipped criteria from deterministic scoring", () => {
		const criteria = validOutput().criteria;
		criteria[READINESS_CRITERION_IDS[0] ?? ""] = {
			status: "pass",
			numerator: 1,
			denominator: 1,
			rationale: "Pass",
			evidence: ["package.json"],
		};
		criteria[READINESS_CRITERION_IDS[1] ?? ""] = {
			status: "fail",
			numerator: 0,
			denominator: 1,
			rationale: "Fail",
			evidence: [],
		};
		expect(summarizeReadiness(criteria)).toEqual({
			criteriaPassed: 1,
			criteriaTotal: 2,
			passRate: 50,
			level: 3,
		});
	});

	it("publishes a closed schema and embeds the rubric in the prompt", () => {
		const schema = readinessJsonSchema();
		expect(schema.additionalProperties).toBe(false);
		const properties = schema.properties as Record<
			string,
			Record<string, unknown>
		>;
		expect(properties.rubricVersion?.type).toBe("string");
		expect(buildReadinessPrompt()).toContain(READINESS_RUBRIC_VERSION);
		expect(buildReadinessPrompt()).toContain("Do not edit");
		const subsetSchema = readinessJsonSchema(["lint_config"]);
		const subsetCriteria = (
			subsetSchema.properties as Record<string, Record<string, unknown>>
		).criteria as Record<string, unknown>;
		expect(subsetCriteria.required).toEqual(["lint_config"]);
	});

	it("builds read-only headless commands for every supported provider", () => {
		const schema = "package.json";
		const output = "/tmp/codev-readiness-test-output.json";
		const claude = buildAgentCommand(
			"claude",
			"scan",
			schema,
			output,
			undefined,
			"test-model",
		);
		const codex = buildAgentCommand(
			"codex",
			"scan",
			schema,
			output,
			undefined,
			"test-model",
		);
		const openCode = buildAgentCommand(
			"opencode",
			"scan",
			schema,
			output,
			undefined,
			"test-model",
		);
		expect(claude.args).toContain("--permission-mode");
		expect(claude.args).toContain("plan");
		expect(codex.args).toContain("read-only");
		expect(codex.args).toContain("--output-schema");
		expect(openCode.args).toContain("-m");
		expect(openCode.args).toContain("aigateway/MiniMax/MiniMax-M2.7");
		expect(claude.args).toContain("test-model");
		expect(codex.args).toContain("test-model");
		expect(openCode.args).toContain("json");
		expect(openCode.args.at(-1)).toContain(READINESS_RUBRIC_VERSION);
		expect(openCode.args.at(-1)).toContain('"criteria"');
		expect(claude.args).not.toContain("--max-budget-usd");
		expect(
			buildAgentCommand("claude", "scan", schema, output).args,
		).not.toContain("--model");
		expect(
			buildAgentCommand("codex", "scan", schema, output).args,
		).not.toContain("--model");
	});

	it("gives OpenCode the structured contract that its CLI cannot accept as a schema flag", () => {
		const instruction = openCodeStructuredOutputInstruction();
		expect(instruction).toContain('"rubricVersion"');
		expect(instruction).toContain('"status":"pass|fail|skipped"');
		expect(instruction).toContain(
			"every criterion listed in the Semantic rubric",
		);
	});

	it("writes a concrete gateway URL into the isolated OpenCode config", () => {
		const config = openCodeReadinessConfig(
			{
				apiKey: "sk-test",
				baseUrl: "https://gateway.example.test/v1",
			},
			"MiniMax/MiniMax-M2.7",
		);

		expect(config.provider.aigateway.options.baseURL).toBe(
			"https://gateway.example.test/v1",
		);
		expect(JSON.stringify(config)).not.toContain("undefined/chat/completions");
	});

	it("removes CoDev shims from readiness subprocess PATH resolution", () => {
		const env = readinessProcessEnv(
			{},
			{
				...process.env,
				PATH: [
					join(homedir(), ".codev-hub", "bin"),
					"/opt/homebrew/bin",
					"/usr/bin",
				].join(delimiter),
			},
		);

		expect(env.PATH).toBe(["/opt/homebrew/bin", "/usr/bin"].join(delimiter));
	});

	it("isolates Claude readiness from ambient provider credentials", () => {
		const env = readinessProcessEnv(claudeReadinessEnvOverrides(), {
			...process.env,
			ANTHROPIC_BASE_URL: "http://unrelated-provider.invalid",
			ANTHROPIC_AUTH_TOKEN: "unrelated-token",
		});

		expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
	});

	it("requires the selected harness to have been configured by codev install", () => {
		const detect = vi
			.spyOn(configure, "detectConfiguredTools")
			.mockReturnValue(["claude-code"]);
		try {
			expect(() => assertReadinessPrerequisites("opencode")).toThrow(
				/codevhub install/,
			);
			expect(() => assertReadinessPrerequisites("claude")).not.toThrow();
			// Codex may use its own ChatGPT subscription authentication without a
			// CoDev-managed internal-gateway configuration.
			expect(() => assertReadinessPrerequisites("codex")).not.toThrow();
		} finally {
			detect.mockRestore();
		}
	});

	it("refreshes only readiness agents backed by the internal gateway", () => {
		expect(gatewayToolForReadiness("claude")).toBe("claude-code");
		expect(gatewayToolForReadiness("opencode")).toBe("opencode");
		expect(gatewayToolForReadiness("codex")).toBeUndefined();
	});

	it("uses an explicit per-run model without making the rubric configurable", () => {
		expect(readinessRuntimeConfig("test-model").opencodeModel).toBe(
			"aigateway/MiniMax/MiniMax-M2.7",
		);
		expect(readinessRuntimeConfig("test-model").maxRepairs).toBe(2);
	});

	it("turns provider JSON events into safe progress messages", () => {
		expect(
			activityFromLine(
				JSON.stringify({ type: "tool_use", part: { tool: "glob" } }),
			),
		).toBe("Inspecting repository with glob");
		expect(
			activityFromLine(
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "tool_use", name: "Read" }] },
				}),
			),
		).toBe("Inspecting repository with Read");
		expect(activityFromLine("not json")).toBeUndefined();
		expect(
			providerFailureFromLine(
				JSON.stringify({
					type: "system",
					subtype: "api_retry",
					error: "authentication_failed",
				}),
			),
		).toContain("codevhub login");
	});

	it("extracts structured results from Claude, Codex, and OpenCode envelopes", () => {
		const output = validOutput();
		const encoded = JSON.stringify(output);
		expect(
			extractAgentOutput(
				JSON.stringify({ type: "result", structured_output: output }),
			),
		).toEqual(output);
		expect(
			extractAgentOutput(
				`${JSON.stringify({ type: "thread.started", thread_id: "abc" })}\n${JSON.stringify({ type: "item.completed", text: encoded })}`,
			),
		).toEqual(output);
		expect(
			extractAgentOutput(
				JSON.stringify({ type: "text", part: { text: encoded } }),
			),
		).toEqual(output);
	});
});
