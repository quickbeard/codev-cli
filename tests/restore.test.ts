import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRestore } from "@/restore.js";

let tempDir: string;
let homedirSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-restore-test-"));
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir);
	logSpy = spyOn(console, "log").mockImplementation(() => {});
	errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	homedirSpy.mockRestore();
	logSpy.mockRestore();
	errorSpy.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
});

function seedBackup(relBackupPath: string, marker: string) {
	const backupPath = join(tempDir, relBackupPath);
	mkdirSync(backupPath, { recursive: true });
	writeFileSync(join(backupPath, "marker.json"), JSON.stringify({ marker }));
	return backupPath;
}

describe("runRestore", () => {
	test("restores Claude from backup and prints success", () => {
		const livePath = join(tempDir, ".claude");
		const backupPath = seedBackup(".claude.backup", "claude-backup");
		mkdirSync(livePath, { recursive: true });
		writeFileSync(join(livePath, "marker.json"), '{"marker":"claude-live"}');

		const code = runRestore("claude-code");

		expect(code).toBe(0);
		expect(existsSync(backupPath)).toBe(false);
		const restored = JSON.parse(
			readFileSync(join(livePath, "marker.json"), "utf-8"),
		);
		expect(restored.marker).toBe("claude-backup");

		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			logs.some(
				(l: string) =>
					l.startsWith("Restored ") &&
					l.includes(livePath) &&
					l.includes(backupPath),
			),
		).toBe(true);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("restores OpenCode from backup and prints success", () => {
		const livePath = join(tempDir, ".config", "opencode");
		const backupPath = seedBackup(".config/opencode.backup", "opencode-backup");

		const code = runRestore("opencode");

		expect(code).toBe(0);
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(livePath)).toBe(true);

		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			logs.some(
				(l: string) =>
					l.startsWith("Restored ") &&
					l.includes(livePath) &&
					l.includes(backupPath),
			),
		).toBe(true);
	});

	test("returns 1 and prints no-backup error for Claude", () => {
		const code = runRestore("claude-code");

		expect(code).toBe(1);
		const errors = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			errors.some(
				(e: string) =>
					e.startsWith("No backup found at") &&
					e.includes(join(tempDir, ".claude.backup")),
			),
		).toBe(true);
		expect(logSpy).not.toHaveBeenCalled();
	});

	test("returns 1 and prints no-backup error for OpenCode", () => {
		const code = runRestore("opencode");

		expect(code).toBe(1);
		const errors = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			errors.some(
				(e: string) =>
					e.startsWith("No backup found at") &&
					e.includes(join(tempDir, ".config", "opencode.backup")),
			),
		).toBe(true);
	});
});
