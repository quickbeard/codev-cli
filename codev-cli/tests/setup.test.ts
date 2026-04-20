import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let homedirSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-test-"));
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir);
});

afterEach(() => {
	homedirSpy.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("setupClaude", () => {
	test("creates .claude.json with hasCompletedOnboarding when file does not exist", async () => {
		// Re-import to pick up the mocked homedir
		const { setupClaude } = await import("@/setup.js");
		await setupClaude();

		const filePath = join(tempDir, ".claude.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
	});

	test("adds hasCompletedOnboarding to existing file without it", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, JSON.stringify({ someKey: "someValue" }, null, 2));

		const { setupClaude } = await import("@/setup.js");
		await setupClaude();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
		expect(config.someKey).toBe("someValue");
	});

	test("does not overwrite file when hasCompletedOnboarding already set", async () => {
		const filePath = join(tempDir, ".claude.json");
		const original = { hasCompletedOnboarding: true, other: "data" };
		writeFileSync(filePath, JSON.stringify(original, null, 2));

		const { setupClaude } = await import("@/setup.js");
		await setupClaude();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config).toEqual(original);
	});

	test("handles invalid JSON in existing file", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, "not valid json{{{");

		const { setupClaude } = await import("@/setup.js");
		await setupClaude();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
	});
});
