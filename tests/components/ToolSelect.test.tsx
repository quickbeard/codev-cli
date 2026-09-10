import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ToolSelect } from "@/components/ToolSelect.js";

afterEach(() => {
	cleanup();
});

describe("ToolSelect", () => {
	test("renders all tool options", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(<ToolSelect onConfirm={onConfirm} />);

		const output = lastFrame() ?? "";
		expect(output).toContain("CoDev Code");
		expect(output).toContain("Claude Code");
		expect(output).toContain("OpenCode");
		expect(output).toContain("Codex");
		expect(output).toContain("Claude Code (extension)");
		expect(output).toContain("Continue (extension)");
	});

	test("emits the `claude-code-ext` sentinel when the Claude Code (extension) row is picked", async () => {
		// The extension rows are editor-agnostic; the merged editor sub-
		// select runs next. ToolSelect emits a sentinel that InstallApp
		// expands into `vscode-claude-code` and/or `jetbrains-claude-code`
		// via EditorSelect. The always-on codev-code leads every emitted list.
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Four down-arrows to reach the 5th (Claude Code (extension)) row.
		for (let i = 0; i < 4; i++) {
			stdin.write("\x1B[B");
			await new Promise((r) => setTimeout(r, 50));
		}
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["codev-code", "claude-code-ext"]);
	});

	test("emits the `continue` sentinel when the Continue (extension) row is picked", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Five down-arrows to reach the 6th (Continue (extension)) row.
		for (let i = 0; i < 5; i++) {
			stdin.write("\x1B[B");
			await new Promise((r) => setTimeout(r, 50));
		}
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["codev-code", "continue"]);
	});

	test("renders the locked CoDev Code row pre-checked and the rest unchecked", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(<ToolSelect onConfirm={onConfirm} />);

		const output = lastFrame() ?? "";
		// Exactly one filled box — the always-on CoDev Code row — and the five
		// optional agents render unchecked.
		expect((output.match(/■/g) ?? []).length).toBe(1);
		expect(output).toContain("□");
		expect(output).toContain("(always installed)");
	});

	test("shows the '(always configured)' suffix in config mode", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<ToolSelect onConfirm={onConfirm} mode="config" />,
		);

		const output = lastFrame() ?? "";
		expect(output).toContain("(always configured)");
		expect(output).not.toContain("(always installed)");
	});

	test("space on the locked CoDev Code row is a no-op", async () => {
		const onConfirm = vi.fn();
		const { lastFrame, stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Cursor starts on the locked row; space must not add a second check.
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect((output.match(/■/g) ?? []).length).toBe(1);
	});

	test("selects an optional tool with space", async () => {
		const onConfirm = vi.fn();
		const { lastFrame, stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Down to Claude Code, then select it.
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		// Two filled boxes now: the locked CoDev Code + the selected Claude Code.
		expect((output.match(/■/g) ?? []).length).toBe(2);
	});

	test("calls onConfirm with codev-code plus the selected tools on enter", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// One down-arrow to reach the Claude Code row (CoDev Code sits first).
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["codev-code", "claude-code"]);
	});

	test("always emits codev-code even when no optional agent is selected", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Enter with nothing else picked still proceeds — the locked default
		// guarantees a non-empty selection.
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["codev-code"]);
	});

	test("can select multiple tools", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Down to Claude Code (row 1), select, down to Codex (row 2), select.
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith([
			"codev-code",
			"claude-code",
			"codex",
		]);
	});

	test("can select Codex by moving cursor down twice", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["codev-code", "codex"]);
	});

	test("can deselect a tool", async () => {
		const onConfirm = vi.fn();
		const { lastFrame, stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Move to an optional tool (Claude Code) and toggle it on.
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		let output = lastFrame() ?? "";
		// Locked CoDev Code + the just-selected Claude Code.
		expect((output.match(/■/g) ?? []).length).toBe(2);

		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		output = lastFrame() ?? "";
		// Deselecting drops back to just the locked CoDev Code row.
		expect((output.match(/■/g) ?? []).length).toBe(1);
	});
});
