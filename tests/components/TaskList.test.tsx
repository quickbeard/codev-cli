import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { TaskList } from "@/components/TaskList.js";

const VERB = {
	infinitive: "install",
	present: "Installing",
	past: "Installed",
};

afterEach(() => {
	cleanup();
});

function allFrames(frames: string[]): string {
	return frames.join("\n");
}

describe("TaskList", () => {
	test("renders a row for each task with the pending label initially", () => {
		const { lastFrame } = render(
			<TaskList
				tasks={[
					{ key: "a", label: "pkg-a", run: () => new Promise(() => {}) },
					{ key: "b", label: "pkg-b", run: () => new Promise(() => {}) },
				]}
				verb={VERB}
				onDone={() => {}}
			/>,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("pkg-a");
		expect(out).toContain("pkg-b");
	});

	test("shows 'Installing ...' while tasks are running", async () => {
		const { frames } = render(
			<TaskList
				tasks={[{ key: "a", label: "pkg-a", run: () => new Promise(() => {}) }]}
				verb={VERB}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 30));
		expect(allFrames(frames)).toContain("Installing pkg-a...");
	});

	test("marks a task as done and calls onDone(true) on success", async () => {
		const onDone = mock(() => {});
		const { frames } = render(
			<TaskList
				tasks={[{ key: "a", label: "pkg-a", run: () => Promise.resolve(null) }]}
				verb={VERB}
				onDone={onDone}
			/>,
		);
		await new Promise((r) => setTimeout(r, 50));
		expect(allFrames(frames)).toContain("Installed pkg-a");
		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith(true);
	});

	test("marks a task as failed and uses the infinitive verb in the error", async () => {
		const onDone = mock(() => {});
		const { frames } = render(
			<TaskList
				tasks={[
					{
						key: "a",
						label: "pkg-a",
						run: () => Promise.resolve("disk full"),
					},
				]}
				verb={VERB}
				onDone={onDone}
			/>,
		);
		await new Promise((r) => setTimeout(r, 50));
		expect(allFrames(frames)).toContain("Failed to install pkg-a: disk full");
		expect(onDone).toHaveBeenCalledWith(false);
	});

	test("respects the provided verb (update case)", async () => {
		const { frames } = render(
			<TaskList
				tasks={[
					{
						key: "a",
						label: "pkg-a",
						run: () =>
							new Promise<string | null>((resolve) =>
								setTimeout(() => resolve(null), 30),
							),
					},
				]}
				verb={{ infinitive: "update", present: "Updating", past: "Updated" }}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(allFrames(frames)).toContain("Updating pkg-a...");
		await new Promise((r) => setTimeout(r, 50));
		expect(allFrames(frames)).toContain("Updated pkg-a");
	});

	test("only calls onDone after the final frame shows every task settled", async () => {
		// Regression: onDone used to fire from inside the run-promise chain,
		// so the parent's exit() could unmount before Ink flushed the last
		// "Updated pkg-X"/"Failed to ..." commit to the terminal. onDone must
		// run only after React has committed the terminal status for every row.
		let frameAtDone: string | null = null;
		const captureFrame = mock((_success: boolean) => {});
		const onDone = (success: boolean) => {
			frameAtDone = lastFrame() ?? "";
			captureFrame(success);
		};

		// Mix a fast task, a slow task, and a failing task so the race window
		// is nontrivial. The last settling task is `slow`, which is also the
		// one most likely to be missing from the frame if the race regresses.
		const { lastFrame } = render(
			<TaskList
				tasks={[
					{
						key: "a",
						label: "pkg-a",
						run: () =>
							new Promise<string | null>((resolve) =>
								setTimeout(() => resolve(null), 5),
							),
					},
					{
						key: "b",
						label: "pkg-b",
						run: () =>
							new Promise<string | null>((resolve) =>
								setTimeout(() => resolve("boom"), 15),
							),
					},
					{
						key: "c",
						label: "pkg-c",
						run: () =>
							new Promise<string | null>((resolve) =>
								setTimeout(() => resolve(null), 40),
							),
					},
				]}
				verb={VERB}
				onDone={onDone}
			/>,
		);

		await new Promise((r) => setTimeout(r, 120));

		expect(captureFrame).toHaveBeenCalledTimes(1);
		expect(captureFrame).toHaveBeenCalledWith(false);
		// The frame captured inside onDone must already show the terminal
		// status for every task — no "Installing pkg-X..." rows left over.
		expect(frameAtDone).not.toBeNull();
		expect(frameAtDone ?? "").toContain("Installed pkg-a");
		expect(frameAtDone ?? "").toContain("Failed to install pkg-b: boom");
		expect(frameAtDone ?? "").toContain("Installed pkg-c");
		expect(frameAtDone ?? "").not.toContain("Installing pkg-");
	});

	test("calls onDone(false) if any task fails, even when others succeed", async () => {
		const onDone = mock(() => {});
		render(
			<TaskList
				tasks={[
					{ key: "a", label: "pkg-a", run: () => Promise.resolve(null) },
					{ key: "b", label: "pkg-b", run: () => Promise.resolve("boom") },
				]}
				verb={VERB}
				onDone={onDone}
			/>,
		);
		await new Promise((r) => setTimeout(r, 50));
		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith(false);
	});

	test("runs tasks in parallel", async () => {
		const order: string[] = [];
		const makeTask = (key: string, delay: number) => ({
			key,
			label: key,
			run: () =>
				new Promise<string | null>((resolve) => {
					setTimeout(() => {
						order.push(key);
						resolve(null);
					}, delay);
				}),
		});
		render(
			<TaskList
				tasks={[makeTask("slow", 40), makeTask("fast", 10)]}
				verb={VERB}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 100));
		// If sequential, "slow" would finish before "fast".
		expect(order).toEqual(["fast", "slow"]);
	});
});
