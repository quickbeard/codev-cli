import { describe, expect, it, vi } from "vitest";
import { bundledStandardProfile } from "@/lib/readiness-profile.js";
import { ReadinessApp } from "@/ReadinessApp.js";
import { lastNonEmptyFrame, renderWithoutRawMode } from "./helpers/raw-mode.js";

async function settle(ms = 30) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ReadinessApp", () => {
	const loadProfiles = vi.fn(async () => ({
		auth: { access_token: "test" } as never,
		profiles: [bundledStandardProfile()],
	}));

	it("uses the shared Ink wizard style and runs the selected agent", async () => {
		const run = vi.fn(async (_agent, progress?: (message: string) => void) => {
			progress?.("Validating report");
			return { exitCode: 0, message: "Stored report report-1" };
		});
		const { frames } = renderWithoutRawMode(
			<ReadinessApp
				available={{ claude: false, codex: false, opencode: true }}
				run={run}
				loadProfiles={loadProfiles}
				requestedAgent="opencode"
			/>,
		);
		await settle(200);
		expect(frames.join("\n")).toContain("AGENT READINESS");
		expect(frames.join("\n")).toContain("OpenCode");
		expect(frames.join("\n")).toContain("(unavailable)");

		await settle(100);
		expect(run).toHaveBeenCalledWith(
			"opencode",
			expect.any(Function),
			expect.objectContaining({
				profile: expect.objectContaining({ slug: "standard" }),
			}),
		);
		expect(frames.join("\n")).toContain("Stored report report-1");
	});

	it("explains when no supported agent is installed", async () => {
		const { lastFrame } = renderWithoutRawMode(
			<ReadinessApp
				available={{ claude: false, codex: false, opencode: false }}
				run={vi.fn()}
				loadProfiles={loadProfiles}
			/>,
		);
		await settle(200);
		expect(lastFrame()).toContain("No supported coding agent is available");
	});

	it("shows a profile-load failure instead of a read-only agent picker", async () => {
		const loadError = new Error(
			"Readiness profile fetch failed (503): unavailable",
		);
		const { frames } = renderWithoutRawMode(
			<ReadinessApp
				available={{ claude: true, codex: true, opencode: true }}
				run={vi.fn()}
				loadProfiles={vi.fn(async () => {
					throw loadError;
				})}
			/>,
		);

		await settle(100);
		const output = lastNonEmptyFrame(frames);
		expect(output).toContain(loadError.message);
		expect(output).not.toContain("Choose coding agent");
	});
});
