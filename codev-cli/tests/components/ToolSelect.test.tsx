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

	test("renders step header", () => {
		const onConfirm = mock();
		const { lastFrame } = render(<ToolSelect onConfirm={onConfirm} />);

		const output = lastFrame() ?? "";
		expect(output).toContain("Step 1/3");
		expect(output).toContain("Select the AI agent(s) to install and configure");
	});

	test("renders navigation instructions", () => {
		const onConfirm = mock();
		const { lastFrame } = render(<ToolSelect onConfirm={onConfirm} />);

		const output = lastFrame() ?? "";
		expect(output).toContain("↑/↓ to navigate");
		expect(output).toContain("Space to select");
		expect(output).toContain("Enter to confirm");
	});

	test("renders tool icons", () => {
		const onConfirm = mock();
		const { lastFrame } = render(<ToolSelect onConfirm={onConfirm} />);

		const output = lastFrame() ?? "";
		expect(output).toContain("🤖");
		expect(output).toContain("💻");
	});

	test("shows cursor on first item by default", () => {
		const onConfirm = mock();
		const { lastFrame } = render(<ToolSelect onConfirm={onConfirm} />);

		const output = lastFrame() ?? "";
		expect(output).toContain("❯");
	});

	test("moves cursor down with arrow key", async () => {
		const onConfirm = mock();
		const { lastFrame, stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Press down arrow
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		// Cursor should be on OpenCode now (second item highlighted)
		const lines = output.split("\n");
		const openCodeLine = lines.find((l) => l.includes("OpenCode"));
		expect(openCodeLine).toContain("❯");
	});

	test("selects tool with space", async () => {
		const onConfirm = mock();
		const { lastFrame, stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Press space to select first item
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("✔");
	});

	test("calls onConfirm with selected tools on enter", async () => {
		const onConfirm = mock();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Select first item and confirm
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["claude-code"]);
	});

	test("does not call onConfirm when no tools selected", async () => {
		const onConfirm = mock();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Press enter without selecting anything
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).not.toHaveBeenCalled();
	});

	test("can select multiple tools", async () => {
		const onConfirm = mock();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Select first item
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		// Move to second item and select
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		// Confirm
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["claude-code", "opencode"]);
	});

	test("can deselect a tool", async () => {
		const onConfirm = mock();
		const { lastFrame, stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Select first item
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		let output = lastFrame() ?? "";
		expect(output).toContain("✔");

		// Deselect first item
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		output = lastFrame() ?? "";
		expect(output).not.toContain("✔");
	});
});
