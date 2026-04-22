import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "@/run.js";

let tempDir: string;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-run-test-"));
	errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	errorSpy.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("runAgent", () => {
	test("returns 0 when child exits cleanly", async () => {
		expect(await runAgent("node", ["-e", ""])).toBe(0);
	});

	test("returns the child's non-zero exit code", async () => {
		expect(await runAgent("node", ["-e", "process.exit(7)"])).toBe(7);
	});

	test("forwards args verbatim to the child", async () => {
		const outPath = join(tempDir, "argv.json");
		const script = `require('fs').writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(process.argv.slice(1)))`;
		const code = await runAgent("node", [
			"-e",
			script,
			"hello",
			"--flag",
			"world",
		]);
		expect(code).toBe(0);
		const captured = JSON.parse(readFileSync(outPath, "utf-8"));
		expect(captured).toEqual(["hello", "--flag", "world"]);
	});

	test("returns 1 and prints install hint on ENOENT", async () => {
		const code = await runAgent("codev-nonexistent-binary-xyzzy-12345", []);
		expect(code).toBe(1);
		const messages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			messages.some((m: string) =>
				m.includes("is not installed. Run 'codev install'"),
			),
		).toBe(true);
	});

	test("maps signal death to 128 + signo", async () => {
		const code = await runAgent("node", [
			"-e",
			"process.kill(process.pid, 'SIGTERM')",
		]);
		expect(code).toBe(128 + constants.signals.SIGTERM);
	});
});
