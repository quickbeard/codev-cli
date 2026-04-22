import { spawn } from "node:child_process";
import { constants } from "node:os";

export function runAgent(cmd: string, args: string[]): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: "inherit" });

		// The child shares our process group, so the terminal already delivers
		// SIGINT/SIGTERM to it. Swallow them in the parent so we don't exit
		// before the child finishes its own cleanup.
		const swallow = () => {};
		process.on("SIGINT", swallow);
		process.on("SIGTERM", swallow);

		const cleanup = () => {
			process.off("SIGINT", swallow);
			process.off("SIGTERM", swallow);
		};

		child.once("error", (err: NodeJS.ErrnoException) => {
			cleanup();
			if (err.code === "ENOENT") {
				console.error(
					`'${cmd}' is not installed. Run 'codev install' to install it.`,
				);
			} else {
				console.error(`Failed to run ${cmd}: ${err.message}`);
			}
			resolve(1);
		});

		child.once("exit", (code, signal) => {
			cleanup();
			if (code !== null) {
				resolve(code);
				return;
			}
			const signo = signal ? (constants.signals[signal] ?? 0) : 0;
			resolve(128 + signo);
		});
	});
}
