import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { Banner } from "@/components/Banner.js";
import pkg from "../../package.json" with { type: "json" };

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
		expect(output).toContain("AI Coding Agent Hub");
	});

	test("renders the version", () => {
		const { lastFrame } = render(<Banner />);

		const output = lastFrame() ?? "";
		expect(output).toContain(`v${pkg.version}`);
	});

	test("renders the separator line", () => {
		const { lastFrame } = render(<Banner />);

		const output = lastFrame() ?? "";
		expect(output).toContain("─".repeat(45));
	});
});
