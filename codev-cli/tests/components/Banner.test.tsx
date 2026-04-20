import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { Banner } from "@/components/Banner.js";

afterEach(() => {
	cleanup();
});

describe("Banner", () => {
	test("renders the CODEV ASCII logo", () => {
		const { lastFrame } = render(<Banner />);

		const output = lastFrame() ?? "";
		expect(output).toContain("██████╗");
		expect(output).toContain("╚═════╝");
	});

	test("renders the subtitle", () => {
		const { lastFrame } = render(<Banner />);

		const output = lastFrame() ?? "";
		expect(output).toContain("AI Coding Agent Installer");
	});

	test("renders the version", () => {
		const { lastFrame } = render(<Banner />);

		const output = lastFrame() ?? "";
		expect(output).toContain("v0.1.0");
	});

	test("renders the separator line", () => {
		const { lastFrame } = render(<Banner />);

		const output = lastFrame() ?? "";
		expect(output).toContain("─".repeat(45));
	});
});
