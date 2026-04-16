import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Tool = "claude-code" | "opencode";

export async function setupClaude() {
	const claudeJsonPath = join(homedir(), ".claude.json");

	let config: Record<string, unknown> = {};
	if (existsSync(claudeJsonPath)) {
		try {
			config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
		} catch {
			config = {};
		}
	}

	if (!config.hasCompletedOnboarding) {
		config.hasCompletedOnboarding = true;
		writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
	}
}
