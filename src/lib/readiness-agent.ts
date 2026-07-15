import { spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApiKey } from "@/lib/auth.js";
import { detectConfiguredTools } from "@/lib/configure.js";
import { AI_GATEWAY_OPENAI_URL } from "@/lib/const.js";
import { readinessRuntimeConfig } from "@/lib/readiness-config.js";
import {
	type AgentReadinessOutput,
	READINESS_RUBRIC,
	READINESS_RUBRIC_VERSION,
	readinessJsonSchema,
} from "@/lib/readiness-contract.js";
import { stripShimDirFromPath } from "@/lib/shims.js";

export const READINESS_AGENTS = ["claude", "codex", "opencode"] as const;
export type ReadinessAgent = (typeof READINESS_AGENTS)[number];

export function assertReadinessPrerequisites(agent: ReadinessAgent): void {
	if (agent === "codex" && isAgentAvailable(agent)) return;
	const tool = agent === "claude" ? "claude-code" : agent;
	if (detectConfiguredTools().includes(tool)) return;
	throw new Error(
		`${agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "OpenCode"} is not configured by CoDev. Run \`codev install\`, select this agent, and retry the readiness scan.`,
	);
}

export interface AgentRunResult {
	output: AgentReadinessOutput;
	raw: string;
	provider: ReadinessAgent;
	durationMs: number;
	sessionId?: string;
}

interface ProcessResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type AgentProgress = (message: string) => void;

export function activityFromLine(line: string): string | undefined {
	try {
		const event = JSON.parse(line) as Record<string, unknown>;
		const part = event.part as Record<string, unknown> | undefined;
		const item = event.item as Record<string, unknown> | undefined;
		const message = event.message as Record<string, unknown> | undefined;
		const content = Array.isArray(message?.content)
			? (message.content as Array<Record<string, unknown>>)
			: [];
		const claudeTool = content.find(
			(entry) => entry.type === "tool_use" && typeof entry.name === "string",
		)?.name;
		const tool =
			(typeof part?.tool === "string" && part.tool) ||
			(typeof claudeTool === "string" && claudeTool) ||
			(typeof item?.type === "string" && item.type === "command_execution"
				? "command"
				: undefined);
		if (tool) return `Inspecting repository with ${tool}`;
		if (event.type === "turn.started" || event.type === "step_start")
			return "Agent evaluation step started";
		if (event.type === "turn.completed" || event.type === "step_finish")
			return "Agent evaluation step completed";
		if (event.type === "item.completed")
			return "Processing repository evidence";
	} catch {}
	return undefined;
}

export function providerFailureFromLine(line: string): string | undefined {
	try {
		const event = JSON.parse(line) as Record<string, unknown>;
		if (
			event.type === "system" &&
			event.subtype === "api_retry" &&
			event.error === "authentication_failed"
		)
			return "Agent authentication failed. Run `codev login`, then `codev config` to refresh the selected harness credentials.";
	} catch {}
	return undefined;
}

export function isAgentAvailable(agent: ReadinessAgent): boolean {
	return (
		spawnSync(agent, ["--version"], {
			stdio: "ignore",
			timeout: 5_000,
			env: readinessProcessEnv(),
		}).status === 0
	);
}

export function readinessProcessEnv(
	overrides: NodeJS.ProcessEnv = {},
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return {
		...base,
		PATH: stripShimDirFromPath(base.PATH),
		...overrides,
	};
}

export function claudeReadinessEnvOverrides(): NodeJS.ProcessEnv {
	return {
		ANTHROPIC_API_KEY: undefined,
		ANTHROPIC_AUTH_TOKEN: undefined,
		ANTHROPIC_BASE_URL: undefined,
		ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
		ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
		ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
		ANTHROPIC_MODEL: undefined,
		CLAUDE_CODE_USE_BEDROCK: undefined,
		CLAUDE_CODE_USE_VERTEX: undefined,
	};
}

export function buildReadinessPrompt(): string {
	return `You are evaluating how ready a software repository is for autonomous coding agents.

Work read-only. Do not edit, create, delete, format, commit, install dependencies, access the network, or spawn subagents. You may inspect repository files and git history and run safe, non-mutating diagnostic commands. Judge semantic evidence across languages and frameworks; do not rely only on filenames.

Finish efficiently. First inventory the repository with one batched file-listing command. Prefer manifests, CI configuration, test configuration, documentation, security policy, deployment files, and a small representative source sample. Batch related reads/searches and reuse the same evidence across criteria. Do not inspect every source file or run expensive builds/tests. Aim for no more than 12 repository commands before producing the report.

Discover independently deployable applications first. Evaluate every rubric criterion. Use "skipped" only when it is genuinely inapplicable or cannot be established from local evidence. A failure means the criterion applies but adequate support is absent. For application-scoped criteria, numerator and denominator count evaluated applications. Repository-scoped criteria use denominator 1. Evidence entries must be existing repository-relative file or directory paths; file paths may optionally be followed by a line number. Use an empty evidence array when the rationale describes something that is absent. Never cite a nonexistent placeholder, URL, or command as evidence; describe command evidence in the rationale instead.

Return only the JSON object matching the supplied schema. Do not include aggregate scores.

Rubric version: ${READINESS_RUBRIC_VERSION}
Rubric:
${JSON.stringify(READINESS_RUBRIC, null, 2)}`;
}

export function openCodeStructuredOutputInstruction(): string {
	return `Return exactly one JSON object with this shape and no markdown fence:
{"rubricVersion":"${READINESS_RUBRIC_VERSION}","languages":["string"],"applications":[{"path":".","description":"string","languages":["string"]}],"criteria":{"<every rubric id>":{"status":"pass|fail|skipped","numerator":"integer or null","denominator":"positive integer","rationale":"string","evidence":["existing repository-relative path"]}},"warnings":["string"],"recommendations":["2 or 3 strings"],"model":"string or null"}
Use null numerator only for skipped criteria. Include every rubric id exactly once and no additional criterion ids.`;
}

export function buildAgentCommand(
	agent: ReadinessAgent,
	prompt: string,
	schemaPath: string,
	outputPath: string,
	sessionId?: string,
	modelOverride?: string,
): { command: string; args: string[] } {
	if (agent === "claude") {
		const args = [
			"-p",
			prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--json-schema",
			readFileSync(schemaPath, "utf8"),
			"--permission-mode",
			"plan",
			"--max-turns",
			"80",
			"--allowedTools",
			"Read",
			"Glob",
			"Grep",
			"Bash(git status:*)",
			"Bash(git log:*)",
			"Bash(git show:*)",
			"Bash(git diff:*)",
			"Bash(git ls-files:*)",
		];
		if (modelOverride) args.push("--model", modelOverride);
		if (sessionId) args.push("--resume", sessionId);
		return { command: "claude", args };
	}
	if (agent === "codex") {
		const config = readinessRuntimeConfig(modelOverride);
		const modelArgs = [
			...(config.model ? ["--model", config.model] : []),
			"--config",
			`model_reasoning_effort=${JSON.stringify(config.codexReasoningEffort)}`,
		];
		if (sessionId)
			return {
				command: "codex",
				args: [
					"exec",
					"resume",
					...modelArgs,
					"--json",
					"--output-schema",
					schemaPath,
					"--output-last-message",
					outputPath,
					sessionId,
					prompt,
				],
			};
		return {
			command: "codex",
			args: [
				"exec",
				...modelArgs,
				"--sandbox",
				"read-only",
				"--json",
				"--output-schema",
				schemaPath,
				"--output-last-message",
				outputPath,
				prompt,
			],
		};
	}
	const args = [
		"run",
		"--format",
		"json",
		"-m",
		readinessRuntimeConfig().opencodeModel,
		`${prompt}\n\n${openCodeStructuredOutputInstruction()}`,
	];
	if (sessionId) args.push("--session", sessionId);
	return { command: "opencode", args };
}

function runProcess(
	command: string,
	args: string[],
	cwd: string,
	envOverrides: NodeJS.ProcessEnv = {},
	timeoutMs?: number,
	onProgress: AgentProgress = () => {},
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const config = readinessRuntimeConfig();
		const child = spawn(command, args, {
			cwd,
			env: readinessProcessEnv(envOverrides),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		let size = 0;
		let timedOut = false;
		let stdoutLines = "";
		let lastProgress = 0;
		let providerFailure: string | undefined;
		const effectiveTimeoutMs = timeoutMs ?? config.timeoutMs;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
		}, effectiveTimeoutMs);
		const append = (target: "out" | "err", chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > config.maxOutputBytes) {
				child.kill("SIGTERM");
				return;
			}
			if (target === "out") {
				const text = chunk.toString();
				out += text;
				stdoutLines += text;
				const lines = stdoutLines.split("\n");
				stdoutLines = lines.pop() ?? "";
				for (const line of lines) {
					const failure = providerFailureFromLine(line);
					if (failure && !providerFailure) {
						providerFailure = failure;
						child.kill("SIGTERM");
					}
					const activity = activityFromLine(line);
					if (activity && Date.now() - lastProgress >= 500) {
						lastProgress = Date.now();
						onProgress(activity);
					}
				}
			} else err += chunk.toString();
		};
		child.stdout.on("data", (chunk: Buffer) => append("out", chunk));
		child.stderr.on("data", (chunk: Buffer) => append("err", chunk));
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (providerFailure) reject(new Error(providerFailure));
			else if (timedOut)
				reject(new Error(`Agent timed out after ${effectiveTimeoutMs} ms.`));
			else if (size > config.maxOutputBytes)
				reject(
					new Error(`Agent output exceeded ${config.maxOutputBytes} bytes.`),
				);
			else resolve({ code: code ?? 1, stdout: out, stderr: err });
		});
	});
}

function jsonCandidates(raw: string): unknown[] {
	const candidates: unknown[] = [];
	const add = (text: string) => {
		try {
			candidates.push(JSON.parse(text));
		} catch {}
	};
	add(raw.trim());
	for (const line of raw.split("\n")) add(line.trim());
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
	if (fenced) add(fenced.trim());
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end > start) add(raw.slice(start, end + 1));
	return candidates;
}

function findOutput(value: unknown): AgentReadinessOutput | undefined {
	if (!value || typeof value !== "object") return undefined;
	const object = value as Record<string, unknown>;
	if (object.rubricVersion && object.criteria)
		return object as unknown as AgentReadinessOutput;
	for (const key of [
		"structured_output",
		"result",
		"content",
		"text",
		"message",
		"data",
		"part",
	]) {
		const nested = object[key];
		if (typeof nested === "string") {
			for (const candidate of jsonCandidates(nested)) {
				const found = findOutput(candidate);
				if (found) return found;
			}
		} else {
			const found = findOutput(nested);
			if (found) return found;
		}
	}
	if (Array.isArray(value))
		for (const item of value) {
			const found = findOutput(item);
			if (found) return found;
		}
	return undefined;
}

export function extractAgentOutput(
	raw: string,
): AgentReadinessOutput | undefined {
	for (const candidate of jsonCandidates(raw)) {
		const output = findOutput(candidate);
		if (output) return output;
	}
	return undefined;
}

function sessionIdFrom(raw: string): string | undefined {
	for (const candidate of jsonCandidates(raw)) {
		if (candidate && typeof candidate === "object") {
			const object = candidate as Record<string, unknown>;
			for (const key of ["session_id", "sessionID", "thread_id", "threadId"])
				if (typeof object[key] === "string") return object[key];
		}
	}
	return undefined;
}

export async function runReadinessAgent(
	agent: ReadinessAgent,
	root: string,
	repair?: { raw: string; errors: string[]; sessionId?: string },
	modelOverride?: string,
	onProgress: AgentProgress = () => {},
): Promise<AgentRunResult> {
	const temp = mkdtempSync(join(tmpdir(), "codev-readiness-"));
	const schemaPath = join(temp, "schema.json");
	const outputPath = join(temp, "output.json");
	writeFileSync(schemaPath, JSON.stringify(readinessJsonSchema()));
	let envOverrides: NodeJS.ProcessEnv = {};
	if (agent === "claude") envOverrides = claudeReadinessEnvOverrides();
	if (agent === "opencode") {
		const credentials = loadApiKey();
		if (!credentials?.apiKey)
			throw new Error(
				"OpenCode readiness requires gateway credentials. Run `codev install` first.",
			);
		const configDir = join(temp, "config", "opencode");
		mkdirSync(configDir, { recursive: true });
		const model = readinessRuntimeConfig(modelOverride).opencodeModel.replace(
			/^aigateway\//,
			"",
		);
		writeFileSync(
			join(configDir, "opencode.json"),
			JSON.stringify({
				$schema: "https://opencode.ai/config.json",
				model: `aigateway/${model}`,
				provider: {
					aigateway: {
						npm: "@ai-sdk/openai-compatible",
						name: "AI Gateway",
						options: {
							baseURL: credentials.baseUrl ?? AI_GATEWAY_OPENAI_URL,
							apiKey: credentials.apiKey,
						},
						models: { [model]: { name: model } },
					},
				},
			}),
			{ mode: 0o600 },
		);
		envOverrides = {
			XDG_CONFIG_HOME: join(temp, "config"),
			XDG_DATA_HOME: join(temp, "data"),
		};
	}
	const prompt = repair
		? `Your previous readiness output was invalid. Correct it and return the complete JSON object only. Do not rescan or change the repository. Remove nonexistent evidence entries and use an empty evidence array when the rationale describes absence. Existing repository-relative directories are valid evidence. Validation errors:\n${repair.errors.map((error) => `- ${error}`).join("\n")}\nPrevious output:\n${repair.raw.slice(-200_000)}`
		: buildReadinessPrompt();
	const started = Date.now();
	const deadline = started + readinessRuntimeConfig(modelOverride).timeoutMs;
	try {
		const command = buildAgentCommand(
			agent,
			prompt,
			schemaPath,
			outputPath,
			agent === "opencode" ? undefined : repair?.sessionId,
			modelOverride,
		);
		let result = await runProcess(
			command.command,
			command.args,
			root,
			envOverrides,
			Math.max(1, deadline - Date.now()),
			onProgress,
		);
		let sessionId = sessionIdFrom(result.stdout);
		let combinedStdout = result.stdout;
		for (let turn = 1; agent === "opencode" && turn < 2; turn++) {
			if (extractAgentOutput(combinedStdout) || !sessionId) break;
			const continuation = buildAgentCommand(
				agent,
				"Your evaluation response did not match the required readiness contract. Reformat the completed evaluation now without rescanning the repository.",
				schemaPath,
				outputPath,
				sessionId,
				modelOverride,
			);
			result = await runProcess(
				continuation.command,
				continuation.args,
				root,
				envOverrides,
				Math.max(1, deadline - Date.now()),
				onProgress,
			);
			combinedStdout += `\n${result.stdout}`;
			sessionId = sessionIdFrom(result.stdout) ?? sessionId;
		}
		const fileOutput = (() => {
			try {
				return readFileSync(outputPath, "utf8");
			} catch {
				return "";
			}
		})();
		const raw = [fileOutput, combinedStdout].filter(Boolean).join("\n");
		if (result.code !== 0)
			throw new Error(
				`${agent} exited with code ${result.code}: ${[result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(-4_000)}`,
			);
		const output = extractAgentOutput(raw);
		if (!output)
			throw new Error(
				`${agent} did not return a structured readiness object. Output tail:\n${raw.slice(-4_000)}`,
			);
		return {
			output,
			raw,
			provider: agent,
			durationMs: Date.now() - started,
			sessionId,
		};
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}
