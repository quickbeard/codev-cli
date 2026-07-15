import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ReadinessApp } from "@/ReadinessApp.js";

async function settle(ms = 30) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ReadinessApp", () => {
	it("uses the shared Ink wizard style and runs the selected agent", async () => {
		const run = vi.fn(async (_agent, progress?: (message: string) => void) => {
			progress?.("Validating report");
			return { exitCode: 0, message: "Stored report report-1" };
		});
		const { frames, stdin } = render(
			<ReadinessApp
				available={{ claude: false, codex: false, opencode: true }}
				run={run}
			/>,
		);
		expect(frames.at(-1)).toContain("AGENT READINESS");
		expect(frames.at(-1)).toContain("OpenCode");
		expect(frames.at(-1)).toContain("(unavailable)");

		stdin.write("\r");
		await settle(100);
		expect(run).toHaveBeenCalledWith("opencode", expect.any(Function), {});
		expect(frames.join("\n")).toContain("Stored report report-1");
	});

	it("explains when no supported agent is installed", () => {
		const { lastFrame } = render(
			<ReadinessApp
				available={{ claude: false, codex: false, opencode: false }}
				run={vi.fn()}
			/>,
		);
		expect(lastFrame()).toContain("No supported coding agent is available");
	});
});
