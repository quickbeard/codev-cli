import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ReadinessApp } from "@/ReadinessApp.js";

async function settle(ms = 30) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ReadinessApp arrow-key navigation", () => {
	it("moves cursor down with down-arrow and selects the highlighted agent on Enter", async () => {
		const run = vi.fn(async () => ({
			exitCode: 0,
			message: "ok",
		}));
		const { stdin, frames } = render(
			<ReadinessApp
				available={{ claude: true, codex: true, opencode: true }}
				run={run}
			/>,
		);

		// Cursor starts on Claude (index 0). Press down-arrow to move to Codex.
		stdin.write("\x1b[B");
		await settle();
		expect(frames.at(-1)).toContain("Codex");
		// The cursor highlight (bold) should now be on Codex, not Claude.
		// ink-testing-library strips ANSI, so we check via the selection callback.
		stdin.write("\r");
		await settle(100);
		expect(run).toHaveBeenCalledWith("codex", expect.any(Function), {});
	});

	it("moves cursor up with up-arrow from the middle item", async () => {
		const run = vi.fn(async () => ({
			exitCode: 0,
			message: "ok",
		}));
		const { stdin } = render(
			<ReadinessApp
				available={{ claude: true, codex: true, opencode: true }}
				run={run}
			/>,
		);

		// Move down twice (claude -> codex -> opencode), then up once (opencode -> codex).
		stdin.write("\x1b[B");
		await settle();
		stdin.write("\x1b[B");
		await settle();
		stdin.write("\x1b[A");
		await settle();
		stdin.write("\r");
		await settle(100);
		expect(run).toHaveBeenCalledWith("codex", expect.any(Function), {});
	});

	it("skips unavailable agents when navigating", async () => {
		const run = vi.fn(async () => ({
			exitCode: 0,
			message: "ok",
		}));
		const { stdin } = render(
			<ReadinessApp
				available={{ claude: true, codex: false, opencode: true }}
				run={run}
			/>,
		);

		// Cursor starts on Claude (index 0). Down-arrow should skip Codex (unavailable)
		// and land on OpenCode (index 2).
		stdin.write("\x1b[B");
		await settle();
		stdin.write("\r");
		await settle(100);
		expect(run).toHaveBeenCalledWith("opencode", expect.any(Function), {});
	});
});
