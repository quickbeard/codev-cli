import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as configure from "@/lib/configure.js";
import { runReadiness } from "@/lib/readiness.js";
import type { ReadinessProfile } from "@/lib/readiness-profile.js";

const originalCwd = process.cwd();
const roots: string[] = [];

function deterministicProfile(): ReadinessProfile {
	return {
		id: "profile-1",
		ownerProfileId: "user-1",
		name: "Focused",
		slug: "focused",
		description: "Focused profile",
		scope: "personal",
		isDefault: false,
		status: "published",
		activeVersion: {
			id: "version-2",
			revision: 2,
			contentHash: "sha256:test",
			schemaVersion: "1",
			analyzerVersion: "2026-07-15.v2",
			definition: {
				criteria: [
					{
						key: "tests_configured",
						name: "Tests configured",
						category: "Testing",
						description: "A test script is configured.",
						maturityLevel: 1,
						repositoryScope: "repository",
						enabled: true,
						order: 0,
						passCondition: "A test script exists.",
						evidenceRequirement: "package.json",
						applicability: { kind: "always" },
						evidenceLocators: [
							{
								type: "manifest_script",
								manifest: "package.json",
								name: "test",
							},
						],
						decision: { engine: "deterministic", match: "any" },
						recommendationTemplate: "Add a test script.",
						priority: 1,
					},
				],
			},
		},
	};
}

afterEach(() => {
	process.chdir(originalCwd);
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("profile-aware readiness upload", () => {
	it("uploads the frozen profile identity, snapshot, inventory, and timings", async () => {
		const root = mkdtempSync(join(tmpdir(), "codev-readiness-upload-"));
		roots.push(root);
		execFileSync("git", ["init", "-q"], { cwd: root });
		mkdirSync(join(root, "src"));
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { test: "vitest" } }),
		);
		execFileSync("git", ["add", "."], { cwd: root });
		process.chdir(root);
		vi.spyOn(configure, "detectConfiguredTools").mockReturnValue(["codex"]);
		const fetch = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ report: { id: "report-1" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetch);

		const result = await runReadiness("codex", () => {}, {
			profile: deterministicProfile(),
			auth: { access_token: "test-token" } as never,
			profileFetchMs: 12,
		});

		expect(result.exitCode).toBe(0);
		const request = fetch.mock.calls[0]?.[1];
		if (!request) throw new Error("Readiness upload request was not captured.");
		const payload = JSON.parse(String(request.body)) as Record<string, unknown>;
		expect(payload).toMatchObject({
			readinessProfileId: "profile-1",
			readinessProfileVersionId: "version-2",
			profileRevision: 2,
			profileContentHash: "sha256:test",
			analyzerVersion: "2026-07-15.v2",
			timings: {
				profileFetchMs: 12,
				deterministicMs: expect.any(Number),
				semanticMs: expect.any(Number),
				totalMs: expect.any(Number),
			},
		});
		expect(payload.profileSnapshot).toMatchObject({
			id: "profile-1",
			activeVersion: { id: "version-2" },
		});
		expect(Object.keys(payload.report as object)).toEqual(["tests_configured"]);
	});
});
