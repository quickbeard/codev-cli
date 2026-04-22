import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { ToolSelect } from "@/components/ToolSelect.js";

afterEach(() => {
	cleanup();
});

describe("ToolSelect", () => {
	test("renders both tool options", () => {
		const onConfirm = mock();
		const { lastFrame } = render(<ToolSelect onConfirm={onConfirm} />);

		const output = lastFrame() ?? "";
		expect(output).toContain("Claude Code");
		expect(output).toContain("OpenCode");
	});

	test("renders unchecked checkboxes by default", () => {
		const onConfirm = mock();
		const { lastFrame } = render(<ToolSelect onConfirm={onConfirm} />);

		const output = lastFrame() ?? "";
		expect(output).toContain("□");
		expect(output).not.toContain("■");
	});

	test("selects tool with space", async () => {
		const onConfirm = mock();
		const { lastFrame, stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("■");
	});

	test("calls onConfirm with selected tools on enter", async () => {
		const onConfirm = mock();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["claude-code"]);
	});

	test("does not call onConfirm when no tools selected", async () => {
		const onConfirm = mock();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).not.toHaveBeenCalled();
	});

	test("can select multiple tools", async () => {
		const onConfirm = mock();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["claude-code", "opencode"]);
	});

	test("can deselect a tool", async () => {
		const onConfirm = mock();
		const { lastFrame, stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		let output = lastFrame() ?? "";
		expect(output).toContain("■");

		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		output = lastFrame() ?? "";
		expect(output).not.toContain("■");
	});
});
