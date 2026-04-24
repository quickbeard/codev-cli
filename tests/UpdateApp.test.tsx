import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import { cleanup, render } from "ink-testing-library";
import { UpdateApp } from "@/UpdateApp.js";

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

describe("UpdateApp", () => {
	test("shows 'Happy coding' after a successful update", async () => {
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			if (file === "npm" && args[0] === "install") return { stdout: "ok" };
			if (file === "opencode") return { stdout: "1.0.0" };
			return { stdout: "" };
		});
		const existsSpy = spyOn(fs, "existsSync").mockImplementation(
			(p: fs.PathLike) => String(p) === "/fake/root/opencode-ai",
		);

		const { frames } = render(<UpdateApp />);
		await new Promise((r) => setTimeout(r, 200));

		const history = allFrames(frames);
		expect(history).toContain("Updated opencode-ai");
		expect(history).toContain("Happy coding");
		existsSpy.mockRestore();
	});

	test("shows 'Happy coding' even when there is nothing to update", async () => {
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			return { stdout: "" };
		});
		const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);

		const { frames } = render(<UpdateApp />);
		await new Promise((r) => setTimeout(r, 200));

		const history = allFrames(frames);
		expect(history).toContain("nothing to update");
		expect(history).toContain("Happy coding");
		existsSpy.mockRestore();
	});

	test("does NOT show 'Happy coding' when an update fails", async () => {
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

		const { frames } = render(<UpdateApp />);
		await new Promise((r) => setTimeout(r, 200));

		const history = allFrames(frames);
		expect(history).toContain("Failed to update opencode-ai");
		expect(history).not.toContain("Happy coding");
		existsSpy.mockRestore();
	});
});
