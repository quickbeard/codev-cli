import { describe, expect, it } from "vitest";
import { parseReadinessArgs } from "@/lib/readiness-cli.js";

describe("readiness CLI arguments", () => {
	it("accepts interactive and non-interactive selectors in either flag form", () => {
		expect(
			parseReadinessArgs([
				"--profile=team",
				"--agent",
				"codex",
				"--model",
				"gpt-test",
			]),
		).toEqual({ profile: "team", agent: "codex", model: "gpt-test" });
	});

	it("rejects unknown flags, missing values, duplicates, and OpenCode model overrides", () => {
		expect(() => parseReadinessArgs(["--wat"])).toThrow(/Unknown/);
		expect(() => parseReadinessArgs(["--profile"])).toThrow(/Missing/);
		expect(() =>
			parseReadinessArgs(["--profile", "one", "--profile", "two"]),
		).toThrow(/Duplicate/);
		expect(() =>
			parseReadinessArgs(["--agent", "opencode", "--model", "ignored"]),
		).toThrow(/cannot be used/);
	});
});
