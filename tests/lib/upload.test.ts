import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as auth from "@/lib/auth.js";
import {
	fileSha256,
	filterNewFiles,
	isRefreshableError,
	listMarkdownLogs,
	runUpload,
} from "@/lib/upload.js";

let tempHome: string;
let projectCwd: string;
let cwdSpy: MockInstance;

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-upload-")));
	projectCwd = join(tempHome, "project");
	mkdirSync(projectCwd, { recursive: true });
	vi.stubEnv("HOME", tempHome);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempHome);
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectCwd);
});

afterEach(() => {
	vi.unstubAllEnvs();
	cwdSpy.mockRestore();
	rmSync(tempHome, { recursive: true, force: true });
});

function writeAuth() {
	mkdirSync(join(tempHome, ".codev-hub"), { recursive: true });
	writeFileSync(
		join(tempHome, ".codev-hub", "auth.json"),
		JSON.stringify({
			access_token: "token",
			id_token: "token",
			expires_at: Date.now() + 3600000,
			user: { sub: "u", email: "u@example.com", displayName: "User" },
			supabase_url: "https://test.analysis.example.com",
			supabase_anon_key: "anon",
		}),
	);
}

function writeLog(name = "a.md", content = "hello") {
	const dir = join(tempHome, ".codev-hub", "agent-logs", "project", "codex");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

describe("upload helpers", () => {
	test("lists markdown logs under agent directories only", () => {
		const path = writeLog();
		writeFileSync(
			join(tempHome, ".codev-hub", "agent-logs", "project", "statistics.json"),
			"{}",
		);
		expect(
			listMarkdownLogs(join(tempHome, ".codev-hub", "agent-logs", "project")),
		).toEqual([path]);
	});

	test("hashes and filters unchanged files", () => {
		const path = writeLog("same.md", "same");
		const abs = realpathSync(path);
		const hash = fileSha256(path);
		const existing = new Map([
			[
				abs,
				{
					id: "prev",
					local_file_path: abs,
					local_content_hash: hash,
					uploaded_at: null,
				},
			],
		]);
		expect(filterNewFiles([path], existing)).toEqual([]);
	});

	test("keeps changed files with previous version id", () => {
		const path = writeLog("changed.md", "new");
		const abs = realpathSync(path);
		const existing = new Map([
			[
				abs,
				{
					id: "prev",
					local_file_path: abs,
					local_content_hash: "old",
					uploaded_at: null,
				},
			],
		]);
		const result = filterNewFiles([path], existing);
		expect(result).toHaveLength(1);
		expect(result[0]?.previousVersionId).toBe("prev");
	});

	test("force keeps unchanged files as candidates with their previous version id", () => {
		const path = writeLog("forced.md", "same");
		const abs = realpathSync(path);
		const hash = fileSha256(path);
		const existing = new Map([
			[
				abs,
				{
					id: "prev",
					local_file_path: abs,
					local_content_hash: hash,
					uploaded_at: null,
				},
			],
		]);
		// A matching hash is normally filtered out (see the test above); force
		// keeps it, still carrying the previous version id for lineage.
		const result = filterNewFiles([path], existing, true);
		expect(result).toHaveLength(1);
		expect(result[0]?.previousVersionId).toBe("prev");
	});
});

describe("runUpload", () => {
	test("signals onLoginDone after a fresh login completes", async () => {
		// auth.json has analysis backend coords but no SSO session, so loadAuth() returns
		// null and ensureAuth() must log in. Mock login() to resolve immediately
		// (no browser), then assert onLoginDone fired so the caller can dismiss
		// the login prompt before the upload proceeds.
		mkdirSync(join(tempHome, ".codev-hub"), { recursive: true });
		writeFileSync(
			join(tempHome, ".codev-hub", "auth.json"),
			JSON.stringify({
				supabase_url: "https://test.analysis.example.com",
				supabase_anon_key: "anon",
			}),
		);
		writeLog("fresh.md", "hello");

		const loginSpy = vi.spyOn(auth, "login").mockResolvedValue({
			access_token: "token",
			id_token: "token",
			expires_at: Date.now() + 3600000,
			user: { sub: "u", email: "u@example.com", displayName: "User" },
		});
		const onLoginDone = vi.fn();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/codev-backend/config")) {
				return new Response(
					JSON.stringify({
						supabaseUrl: "https://test.analysis.example.com",
						supabaseAnonKey: "anon",
						gatewayUrl: "https://gw.test/gateway",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/codev-backend/supabase/exchange")) {
				return new Response(
					JSON.stringify({
						access_token: "analysis-upload-token",
						user: { id: "u", email: "u@example.com" },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/rest/v1/conversations")) {
				return new Response("[]", {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/functions/v1/presign-upload")) {
				return new Response(
					JSON.stringify({
						uploadUrl: "https://upload.example.com/file",
						conversationId: "cid",
						storagePath: "u/cid/fresh.md",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://upload.example.com/file") {
				return new Response("", { status: 200 });
			}
			if (url.includes("/functions/v1/confirm-upload")) {
				return new Response(JSON.stringify({ ok: true }));
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			const summary = await runUpload({ onLoginDone });
			expect(loginSpy).toHaveBeenCalledTimes(1);
			expect(onLoginDone).toHaveBeenCalledTimes(1);
			expect(summary.uploaded).toBe(1);
		} finally {
			fetchSpy.mockRestore();
			loginSpy.mockRestore();
		}
	});

	test("presigns, uploads, and confirms new logs", async () => {
		writeAuth();
		writeLog("new.md", "hello");
		const calls: string[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			calls.push(url);
			if (url.includes("/codev-backend/supabase/exchange")) {
				return new Response(
					JSON.stringify({
						access_token: "analysis-upload-token",
						user: { id: "u", email: "u@example.com" },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/rest/v1/conversations")) {
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer analysis-upload-token",
				);
				// Regression guard for the per-page timeout: the conversations
				// fetch must carry an abort signal like every other call here.
				expect(init?.signal).toBeInstanceOf(AbortSignal);
				return new Response("[]", {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/functions/v1/presign-upload")) {
				return new Response(
					JSON.stringify({
						uploadUrl: "https://upload.example.com/file",
						conversationId: "cid",
						storagePath: "u/cid/new.md",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://upload.example.com/file") {
				expect(init?.method).toBe("PUT");
				expect(
					(init?.headers as Record<string, string>)["Content-Encoding"],
				).toBe("gzip");
				return new Response("", { status: 200 });
			}
			if (url.includes("/functions/v1/confirm-upload")) {
				const body = JSON.parse(String(init?.body));
				expect(body.encoding).toBe("gzip");
				expect(body.localContentHash).toBeTruthy();
				return new Response(JSON.stringify({ ok: true }));
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			const summary = await runUpload();
			expect(summary.uploaded).toBe(1);
			expect(summary.failed).toBe(0);
			expect(calls.some((c) => c.includes("presign-upload"))).toBe(true);
			expect(calls.some((c) => c.includes("confirm-upload"))).toBe(true);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("force re-uploads a file whose hash already matches an existing row", async () => {
		writeAuth();
		const path = writeLog("unchanged.md", "hello");
		const abs = realpathSync(path);
		const hash = fileSha256(path);

		let presignCalls = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/codev-backend/supabase/exchange")) {
				return new Response(
					JSON.stringify({
						access_token: "analysis-upload-token",
						user: { id: "u", email: "u@example.com" },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/rest/v1/conversations")) {
				// The stored row already matches the local hash — a normal run would
				// skip this file. Force must re-upload it anyway.
				return new Response(
					JSON.stringify([
						{
							id: "prev",
							local_file_path: abs,
							local_content_hash: hash,
							uploaded_at: null,
						},
					]),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/functions/v1/presign-upload")) {
				presignCalls++;
				return new Response(
					JSON.stringify({
						uploadUrl: "https://upload.example.com/file",
						conversationId: "cid",
						storagePath: "u/cid/unchanged.md",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://upload.example.com/file") {
				return new Response("", { status: 200 });
			}
			if (url.includes("/functions/v1/confirm-upload")) {
				// Lineage preserved: the forced re-upload supersedes the prior row.
				const body = JSON.parse(String(init?.body));
				expect(body.previousVersionId).toBe("prev");
				return new Response(JSON.stringify({ ok: true }));
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			const summary = await runUpload({ force: true });
			expect(summary.uploaded).toBe(1);
			expect(summary.skipped).toBe(0);
			expect(presignCalls).toBe(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("refreshes config and retries when the analysis backend returns 401", async () => {
		writeAuth();
		writeLog("retry.md", "hello");

		let configCalls = 0;
		let conversationCalls = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;

			// backend /config: hand back fresh analysis backend coords on refresh.
			if (url.includes("/codev-backend/config")) {
				configCalls++;
				return new Response(
					JSON.stringify({
						supabaseUrl: "https://test.analysis.example.com",
						supabaseAnonKey: "anon",
						gatewayUrl: "https://gw.test/gateway",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/codev-backend/supabase/exchange")) {
				return new Response(
					JSON.stringify({
						access_token: "analysis-upload-token",
						user: { id: "u", email: "u@example.com" },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/rest/v1/conversations")) {
				conversationCalls++;
				if (conversationCalls === 1) {
					return new Response("unauthorized", { status: 401 });
				}
				return new Response("[]", {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/functions/v1/presign-upload")) {
				return new Response(
					JSON.stringify({
						uploadUrl: "https://upload.example.com/file",
						conversationId: "cid",
						storagePath: "u/cid/retry.md",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://upload.example.com/file") {
				return new Response("", { status: 200 });
			}
			if (url.includes("/functions/v1/confirm-upload")) {
				return new Response(JSON.stringify({ ok: true }));
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			const summary = await runUpload();
			expect(summary.uploaded).toBe(1);
			expect(summary.failed).toBe(0);
			expect(conversationCalls).toBe(2);
			expect(configCalls).toBe(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("does not retry on analysis backend 5xx errors", async () => {
		writeAuth();
		writeLog("nope.md", "hello");

		let configCalls = 0;
		let conversationCalls = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/codev-backend/config")) {
				configCalls++;
				return new Response("{}", {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/codev-backend/supabase/exchange")) {
				return new Response(
					JSON.stringify({
						access_token: "analysis-upload-token",
						user: { id: "u", email: "u@example.com" },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/rest/v1/conversations")) {
				conversationCalls++;
				return new Response("internal error", { status: 503 });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			await expect(runUpload()).rejects.toThrow(/conversations API failed/);
			expect(conversationCalls).toBe(1);
			expect(configCalls).toBe(0);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("refreshes config when analysis backend coords are missing from cache", async () => {
		// Auth file with SSO tokens but no supabase_* fields.
		mkdirSync(join(tempHome, ".codev-hub"), { recursive: true });
		writeFileSync(
			join(tempHome, ".codev-hub", "auth.json"),
			JSON.stringify({
				access_token: "token",
				id_token: "token",
				expires_at: Date.now() + 3600000,
				user: { sub: "u", email: "u@example.com", displayName: "User" },
			}),
		);
		writeLog("first.md", "hello");

		let configCalls = 0;
		let conversationCalls = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/codev-backend/config")) {
				configCalls++;
				return new Response(
					JSON.stringify({
						supabaseUrl: "https://fresh.analysis.example.com",
						supabaseAnonKey: "fresh-anon",
						gatewayUrl: "https://fresh.example.com/gateway",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/codev-backend/supabase/exchange")) {
				return new Response(
					JSON.stringify({
						access_token: "analysis-upload-token",
						user: { id: "u", email: "u@example.com" },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/rest/v1/conversations")) {
				conversationCalls++;
				return new Response("[]", {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/functions/v1/presign-upload")) {
				return new Response(
					JSON.stringify({
						uploadUrl: "https://upload.example.com/file",
						conversationId: "cid",
						storagePath: "u/cid/first.md",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://upload.example.com/file") {
				return new Response("", { status: 200 });
			}
			if (url.includes("/functions/v1/confirm-upload")) {
				return new Response(JSON.stringify({ ok: true }));
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			const summary = await runUpload();
			expect(summary.uploaded).toBe(1);
			expect(summary.failed).toBe(0);
			expect(configCalls).toBe(1);
			expect(conversationCalls).toBe(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("per-file 401 stays in summary.errors and does not trigger refresh-and-retry", async () => {
		writeAuth();
		writeLog("a.md", "hello");

		let configCalls = 0;
		let presignCalls = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/codev-backend/config")) {
				configCalls++;
				return new Response("{}", {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/codev-backend/supabase/exchange")) {
				return new Response(
					JSON.stringify({
						access_token: "analysis-upload-token",
						user: { id: "u", email: "u@example.com" },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/rest/v1/conversations")) {
				return new Response("[]", {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/functions/v1/presign-upload")) {
				presignCalls++;
				return new Response("denied", { status: 401 });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			const summary = await runUpload();
			// The 401 was caught inside the per-file try/catch — recorded as a
			// failure on the candidate, not bubbled out to trigger a refresh.
			expect(summary.uploaded).toBe(0);
			expect(summary.failed).toBe(1);
			expect(summary.errors).toHaveLength(1);
			expect(summary.errors[0]?.message).toMatch(
				/presign-upload failed \(401\)/,
			);
			expect(presignCalls).toBe(1);
			expect(configCalls).toBe(0);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("pages conversations via Range headers until a short page arrives", async () => {
		writeAuth();
		const path = writeLog("paginated.md", "hello");
		const abs = realpathSync(path);
		const hash = fileSha256(path);

		let conversationCalls = 0;
		const ranges: string[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/codev-backend/supabase/exchange")) {
				return new Response(
					JSON.stringify({
						access_token: "analysis-upload-token",
						user: { id: "u", email: "u@example.com" },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/rest/v1/conversations")) {
				conversationCalls++;
				const range = (init?.headers as Record<string, string>).Range;
				if (range) ranges.push(range);
				// Page 1: a full 1000-row page → loop continues.
				if (conversationCalls === 1) {
					const rows = Array.from({ length: 1000 }, (_, i) => ({
						id: `prev-${i}`,
						local_file_path: `/tmp/old-${i}.md`,
						local_content_hash: "old",
						uploaded_at: null,
					}));
					return new Response(JSON.stringify(rows), {
						headers: { "Content-Type": "application/json" },
					});
				}
				// Page 2: short → contains the row we care about; loop exits.
				return new Response(
					JSON.stringify([
						{
							id: "match",
							local_file_path: abs,
							local_content_hash: hash,
							uploaded_at: null,
						},
					]),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			const summary = await runUpload();
			// The matching row landed on page 2 — filterNewFiles must have seen it
			// and skipped the upload. With a single-page implementation it would
			// have been missed and re-uploaded.
			expect(summary.uploaded).toBe(0);
			expect(summary.skipped).toBe(1);
			expect(conversationCalls).toBe(2);
			expect(ranges).toEqual(["0-999", "1000-1999"]);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("propagates the second error if refresh-and-retry also fails", async () => {
		writeAuth();
		writeLog("doomed.md", "hello");

		let configCalls = 0;
		let conversationCalls = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/codev-backend/config")) {
				configCalls++;
				return new Response(
					JSON.stringify({
						supabaseUrl: "https://test.analysis.example.com",
						supabaseAnonKey: "anon",
						gatewayUrl: "https://gw.test/gateway",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/codev-backend/supabase/exchange")) {
				return new Response(
					JSON.stringify({
						access_token: "analysis-upload-token",
						user: { id: "u", email: "u@example.com" },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/rest/v1/conversations")) {
				conversationCalls++;
				return new Response("still-bad", { status: 401 });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			await expect(runUpload()).rejects.toThrow(/conversations API failed/);
			expect(conversationCalls).toBe(2);
			expect(configCalls).toBe(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("isRefreshableError", () => {
	test("true when analysis backend coords are missing from auth.json", () => {
		expect(
			isRefreshableError(
				new Error(
					"Missing supabase_url in ~/.codev-hub/auth.json. Run `codevhub install`...",
				),
			),
		).toBe(true);
	});

	test("true on HTTP 401", () => {
		expect(
			isRefreshableError(
				new Error("conversations API failed (401): unauthorized"),
			),
		).toBe(true);
	});

	test("true on HTTP 403", () => {
		expect(
			isRefreshableError(new Error("presign-upload failed (403): forbidden")),
		).toBe(true);
	});

	test("false on HTTP 500", () => {
		expect(
			isRefreshableError(new Error("conversations API failed (500): boom")),
		).toBe(false);
	});

	test("false on HTTP 404", () => {
		expect(
			isRefreshableError(
				new Error("Backend /supabase/exchange failed (404): Not found"),
			),
		).toBe(false);
	});

	test("false on network errors", () => {
		expect(isRefreshableError(new Error("fetch failed: ECONNREFUSED"))).toBe(
			false,
		);
	});

	test("false on non-Error values", () => {
		expect(isRefreshableError("random string")).toBe(false);
		expect(isRefreshableError(null)).toBe(false);
	});

	test("anchors to `failed (NNN)` and ignores stray (NNN) in error bodies", () => {
		// A 500 whose body happens to contain a literal `(401)` must not be
		// mistaken for a 401 — the anchor guarantees we only key off the status
		// thrown by our own callers.
		expect(
			isRefreshableError(
				new Error(
					"conversations API failed (500): downstream returned (401) for related id",
				),
			),
		).toBe(false);
	});
});
