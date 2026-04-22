import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { VERSION } from "@/const.js";
import { printHelp, printVersion } from "@/help.js";

let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	logSpy.mockRestore();
});

function output(): string {
	return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
}

describe("printVersion", () => {
	test("prints the version string", () => {
		printVersion();
		expect(output().trim()).toBe(VERSION);
	});

	test("does not print the help banner", () => {
		printVersion();
		expect(output()).not.toContain("Usage: codev");
	});
});

describe("printHelp", () => {
	test("does not include the version string", () => {
		printHelp();
		expect(output()).not.toContain(VERSION);
	});

	test("lists the --version flag", () => {
		printHelp();
		expect(output()).toContain("--version");
	});

	test("prints the usage line", () => {
		printHelp();
		expect(output()).toContain("Usage: codev");
	});
});
