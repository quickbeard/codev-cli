import { spawnSync } from "node:child_process";
import { type AuthData, login } from "@/lib/auth.js";
import { BACKEND_URL } from "@/lib/const.js";
import {
	type AgentRunResult,
	assertReadinessPrerequisites,
	type ReadinessAgent,
	runReadinessAgent,
} from "@/lib/readiness-agent.js";
import { readinessRuntimeConfig } from "@/lib/readiness-config.js";
import {
	normalizeReadinessEvidence,
	READINESS_RUBRIC_VERSION,
	summarizeReadiness,
	validateReadinessOutput,
} from "@/lib/readiness-contract.js";
import { ensureFreshGatewayKey } from "@/lib/refresh.js";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

function repositoryState(root: string): string {
	return git(["status", "--porcelain=v1", "--untracked-files=all"], root);
}

function repoUrl(root: string): string {
	return git(["config", "--get", "remote.origin.url"], root) || root;
}

function repoName(url: string): string {
	return (
		url
			.replace(/\.git$/, "")
			.split(/[/:]/)
			.filter(Boolean)
			.at(-1) ?? "repository"
	);
}

export interface ReadinessRunResult {
	exitCode: number;
	message: string;
}

export type ReadinessProgress = (message: string) => void;
export interface ReadinessOptions {
	model?: string;
}

export function gatewayToolForReadiness(
	agent: ReadinessAgent,
): "claude-code" | "opencode" | undefined {
	if (agent === "claude") return "claude-code";
	if (agent === "opencode") return "opencode";
	return undefined;
}

export async function runReadiness(
	agent: ReadinessAgent,
	onProgress: ReadinessProgress = () => {},
	options: ReadinessOptions = {},
): Promise<ReadinessRunResult> {
	const root = process.cwd();
	if (!git(["rev-parse", "--is-inside-work-tree"], root)) {
		return {
			exitCode: 1,
			message: "Readiness must be run inside a git repository.",
		};
	}

	try {
		assertReadinessPrerequisites(agent);
	} catch (error) {
		return {
			exitCode: 1,
			message: error instanceof Error ? error.message : String(error),
		};
	}

	const before = repositoryState(root);
	onProgress(`Scanning repository with ${agent}, this will take a while`);
	let run: AgentRunResult;
	try {
		const gatewayTool = gatewayToolForReadiness(agent);
		if (gatewayTool) await ensureFreshGatewayKey(gatewayTool);
		run = await runReadinessAgent(
			agent,
			root,
			undefined,
			options.model,
			onProgress,
		);
		run = { ...run, output: normalizeReadinessEvidence(run.output, root) };
		let totalDurationMs = run.durationMs;
		let errors = validateReadinessOutput(run.output, root);
		const { maxRepairs } = readinessRuntimeConfig();
		for (
			let attempt = 1;
			errors.length > 0 && attempt <= maxRepairs;
			attempt++
		) {
			onProgress(
				`Repairing invalid report (${attempt}/${maxRepairs}, ${errors.length} validation errors)`,
			);
			run = await runReadinessAgent(
				agent,
				root,
				{
					raw: run.raw,
					errors,
					sessionId: run.sessionId,
				},
				options.model,
				onProgress,
			);
			run = { ...run, output: normalizeReadinessEvidence(run.output, root) };
			totalDurationMs += run.durationMs;
			errors = validateReadinessOutput(run.output, root);
		}
		if (errors.length > 0)
			throw new Error(
				`Report is still invalid after ${maxRepairs} repair attempt${maxRepairs === 1 ? "" : "s"}:\n${errors.map((error) => `- ${error}`).join("\n")}`,
			);
		run = { ...run, durationMs: totalDurationMs };
	} catch (error) {
		return {
			exitCode: 1,
			message: error instanceof Error ? error.message : String(error),
		};
	}

	const after = repositoryState(root);
	if (after !== before) {
		return {
			exitCode: 1,
			message:
				"The agent changed the repository working tree. The report was rejected and not uploaded; review those changes manually.",
		};
	}

	const summary = summarizeReadiness(run.output.criteria);
	const runtimeConfig = readinessRuntimeConfig(options.model);
	const configuredModel =
		agent === "opencode"
			? runtimeConfig.opencodeModel
			: agent === "codex"
				? runtimeConfig.model
				: undefined;
	const url = repoUrl(root);
	const report = Object.fromEntries(
		Object.entries(run.output.criteria).map(([id, item]) => [
			id,
			{
				status: item.status,
				numerator: item.numerator,
				denominator: item.denominator,
				rationale: item.rationale,
				evidence: item.evidence,
			},
		]),
	);
	const payload = {
		repoUrl: url,
		repoName: repoName(url),
		branch: git(["branch", "--show-current"], root),
		commitHash: git(["rev-parse", "HEAD"], root),
		rubricVersion: READINESS_RUBRIC_VERSION,
		languages: run.output.languages,
		apps: Object.fromEntries(
			run.output.applications.map((app) => [
				app.path,
				{ description: app.description, languages: app.languages },
			]),
		),
		report,
		warnings: run.output.warnings,
		recommendations: run.output.recommendations,
		modelUsed: {
			provider: agent,
			model: run.output.model ?? configuredModel ?? null,
			durationMs: run.durationMs,
		},
		// Included for human-readable proxy logs only. The server must recompute these.
		summary,
	};

	onProgress(`Uploading validated Level ${summary.level} report`);
	let authError = "";
	let auth: AuthData;
	try {
		auth = await login(
			(message) => {
				authError = message;
			},
			() => {},
		);
	} catch (error) {
		return {
			exitCode: 1,
			message:
				authError || (error instanceof Error ? error.message : String(error)),
		};
	}
	let response: Response;
	try {
		response = await fetch(`${BACKEND_URL}/readiness/reports`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${auth.access_token}`,
			},
			body: JSON.stringify(payload),
		});
	} catch (error) {
		return {
			exitCode: 1,
			message: `Readiness upload failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!response.ok) {
		return {
			exitCode: 1,
			message: `Readiness upload failed (${response.status}): ${await response.text()}`,
		};
	}
	const data = (await response.json()) as { report?: { id?: string } };
	return {
		exitCode: 0,
		message: `Stored report ${data.report?.id ?? ""} · Level ${summary.level} · ${summary.passRate}% pass · ${summary.criteriaTotal} criteria evaluated`,
	};
}
