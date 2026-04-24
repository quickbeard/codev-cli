import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import { cleanup, render } from "ink-testing-library";
import { Update } from "@/components/Update.js";

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

function stubExecFile(
	handler: (
		file: string,
		args: string[],
	) => { error?: Error | null; stdout?: string; stderr?: string },
) {
	spyOn(child_process, "execFile").mockImplementation(((
		file: string,
		args: string[],
		...rest: unknown[]
	) => {
		const cb = rest[rest.length - 1] as ExecCb;
		const r = handler(file, args);
		setImmediate(() => cb(r.error ?? null, r.stdout ?? "", r.stderr ?? ""));
		return {} as unknown as child_process.ChildProcess;
	}) as unknown as typeof child_process.execFile);
}

function allFrames(frames: string[]): string {
	return frames.join("\n");
}

afterEach(() => {
	cleanup();
});

describe("Update", () => {
	test("renders 'Checking installed agents...' during detection", async () => {
		// Never-resolving npm root keeps detection pending.
		stubExecFile(() => ({ stdout: "" }));
		spyOn(fs, "existsSync").mockReturnValue(false);

		const { frames } = render(<Update onDone={() => {}} />);
		await new Promise((r) => setTimeout(r, 10));
		expect(allFrames(frames)).toContain("Checking installed agents");
	});

	test("calls onDone(true) with a 'nothing to update' message when no agents detected", async () => {
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			return { stdout: "" };
		});
		const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
		const onDone = mock(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await new Promise((r) => setTimeout(r, 80));

		expect(allFrames(frames)).toContain("nothing to update");
		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith(true);
		existsSpy.mockRestore();
	});

	test("updates only tools detected under npm global root", async () => {
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			if (file === "npm" && args[0] === "install") return { stdout: "ok" };
			if (file === "opencode") return { stdout: "1.0.0" };
			return { stdout: "" };
		});
		// Only opencode's package dir exists.
		const existsSpy = spyOn(fs, "existsSync").mockImplementation(
			(p: fs.PathLike) => String(p) === "/fake/root/opencode-ai",
		);
		const onDone = mock(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await new Promise((r) => setTimeout(r, 150));

		const history = allFrames(frames);
		expect(history).toContain("opencode-ai");
		expect(history).not.toContain("@anthropic-ai/claude-code");
		expect(history).toContain("Updated opencode-ai");
		expect(onDone).toHaveBeenCalledWith(true);
		existsSpy.mockRestore();
	});

	test("reports update failure and calls onDone(false)", async () => {
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			if (file === "npm" && args[0] === "install") {
				return { error: new Error("x"), stderr: "permission denied" };
			}
			return { stdout: "" };
		});
		const existsSpy = spyOn(fs, "existsSync").mockImplementation(
			(p: fs.PathLike) => String(p) === "/fake/root/opencode-ai",
		);
		const onDone = mock(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await new Promise((r) => setTimeout(r, 150));

		const history = allFrames(frames);
		expect(history).toContain("Failed to update opencode-ai");
		expect(history).toContain("permission denied");
		expect(onDone).toHaveBeenCalledWith(false);
		existsSpy.mockRestore();
	});
});
