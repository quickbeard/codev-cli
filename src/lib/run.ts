import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { constants } from "node:os";
import { delimiter, join } from "node:path";
import { logError, logInfo, logWarn } from "@/lib/log.js";
import {
	claudeNativeBinaryMissing,
	codevNativeBinaryMissing,
} from "@/lib/npm.js";
import { stripShimDirFromPath } from "@/lib/shims.js";

const AGENT_LABEL: Record<string, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	codev: "CoDev Code",
};

// Indirection so tests can stub the spawn call without intercepting
// node:child_process at the module level (mirrors `spawner` in upload.ts and
// reexec.ts, and `browserOpener` in auth.ts).
export const spawner = {
	spawn: nodeSpawn,
};

// Cheap PATH lookup (no child process). Skips the shim dir, mirroring the spawn
// PATH below, so callers get the real agent rather than our own shim — spawning
// the shim would re-enter the hub. Windows spawns go through the shell (PATHEXT
// resolution), so probe the standard executable extensions.
export function resolveAgentPath(cmd: string): string | undefined {
	const exts =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
			: [""];
	for (const dir of stripShimDirFromPath(process.env.PATH).split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, cmd + ext);
			try {
				accessSync(candidate, fsConstants.X_OK);
				return candidate;
			} catch {
				// Not here — keep scanning.
			}
		}
	}
	return undefined;
}

// Used by the bare-`codevhub` dispatch to decide between opening CoDev Code and
// falling back to the hub help.
export function agentOnPath(cmd: string): boolean {
	return resolveAgentPath(cmd) !== undefined;
}

export function runAgent(cmd: string, args: string[]): Promise<number> {
	return new Promise((resolve) => {
		const label = AGENT_LABEL[cmd] ?? cmd;
		process.stderr.write(`Starting ${label}...\n`);
		// Agent args can carry prompt text (`codevhub claude -p "..."`) — log only
		// the count, never the contents.
		logInfo(`launching ${label}`, {
			action: "process.spawn",
			eventType: "start",
			extra: { agent: cmd, args_count: args.length },
		});
		// Strip ~/.codev-hub/bin from the child's PATH so spawning `claude` resolves
		// the real npm-installed binary, not our shim — otherwise the shim would
		// re-exec `codevhub claude` and infinite-loop.
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PATH: stripShimDirFromPath(process.env.PATH),
		};
		// CoDev Code (the codev-code package) has its own self-updater, but the
		// hub owns updates (`codevhub update`) — disable the agent's updater at
		// every launch so the two never race. The fork renamed its env flags
		// OPENCODE_* → CODEV_* (codev-code #41), so the switch it reads today is
		// CODEV_DISABLE_AUTOUPDATE; the old spelling stays for builds that
		// predate the rename. Setting only the old one disabled nothing.
		if (cmd === "codev") {
			env.CODEV_DISABLE_AUTOUPDATE = "1";
			env.OPENCODE_DISABLE_AUTOUPDATE = "1";
		}
		// On Windows, npm-installed agent binaries are `.cmd` shims (e.g.
		// `opencode.cmd`). Node's `spawn` only consults PATHEXT when shell is
		// enabled, so without it the spawn fails with ENOENT even though the
		// agent is installed. Mirrors the win32 handling in lib/npm.ts.
		//
		// Use the single-string form on Windows — Node 22's DEP0190 deprecates
		// `shell:true` combined with a separate `args` array (the args get
		// naively concatenated and not escaped, which is a command-injection
		// hazard for callers that take untrusted args). For us the args come
		// from process.argv and the concatenation behavior was already the
		// status quo, so this is a byte-for-byte equivalent rewrite that
		// silences the warning.
		const child =
			process.platform === "win32"
				? spawner.spawn(`${cmd} ${args.join(" ")}`, {
						stdio: "inherit",
						env,
						shell: true,
					})
				: spawner.spawn(cmd, args, { stdio: "inherit", env });

		// The child shares our process group (POSIX) / console (Windows), so the
		// terminal already delivers SIGINT/SIGTERM to it. Swallow the first one
		// in the parent so we don't exit before the child finishes its cleanup.
		//
		// Never swallow indefinitely, though: an unconditional swallow makes the
		// hub unkillable whenever the child fails to exit, and the user is left
		// with a frozen terminal and no way out but closing the window. Windows
		// is where this bites — the launch chain runs through several cmd.exe
		// batch shims (our own .cmd shim, npm's codevhub.cmd, the shell:true
		// wrapper below, npm's codev.cmd), and a batch host that catches a
		// console break stops at "Terminate batch job (Y/N)?" instead of
		// exiting. A second interrupt hands the terminal back.
		//
		// This does not fire during a normal agent session: interactive agents
		// hold the terminal in raw mode, where ctrl+c is delivered as input
		// rather than as a signal, so the count only moves once the terminal is
		// generating real interrupts.
		let interrupts = 0;
		const onInterrupt = () => {
			interrupts += 1;
			if (interrupts < 2) return;
			cleanup();
			process.stderr.write(
				`\nStopped waiting for ${label}; it may still be shutting down in the background.\n`,
			);
			logWarn(`abandoned ${label} after repeated interrupts`, {
				action: "process.exit",
				eventType: "end",
				outcome: "failure",
				extra: { agent: cmd, exit_code: 130 },
			});
			resolve(130);
		};
		process.on("SIGINT", onInterrupt);
		process.on("SIGTERM", onInterrupt);

		const cleanup = () => {
			process.off("SIGINT", onInterrupt);
			process.off("SIGTERM", onInterrupt);
		};

		child.once("error", (err: NodeJS.ErrnoException) => {
			cleanup();
			logError(`failed to launch ${label}`, {
				action: "process.exit",
				eventType: "end",
				outcome: "failure",
				err,
				extra: { agent: cmd, code: err.code ?? null },
			});
			if (err.code === "ENOENT") {
				console.error(
					`'${cmd}' could not be launched. If it isn't installed, run 'codevhub install'.`,
				);
			} else {
				console.error(`Failed to run ${cmd}: ${err.message}`);
			}
			resolve(1);
		});

		child.once("exit", async (code, signal) => {
			cleanup();
			if (code !== null) {
				// A non-zero `claude` or `codev` exit can be the leftover
				// placeholder stub rather than the agent (suppressed postinstall /
				// omitted optional dependency). We only add a repair hint when we
				// can positively confirm the native binary is missing, so ordinary
				// agent failures stay quiet.
				//
				// The two stubs fail very differently and only one of them explains
				// itself. Claude's prints "native binary not installed" through the
				// inherited stderr, so the hint just adds the fix. CoDev Code's
				// placeholder is a shell script that npm installs as `codev.exe`,
				// so on Windows the user gets a PE-loader error blaming their
				// Windows version and no clue that a download was skipped — there
				// the hint carries the diagnosis as well.
				const stubbedAgent =
					code !== 0 && (cmd === "claude" || cmd === "codev") ? cmd : null;
				if (stubbedAgent === "claude" && (await claudeNativeBinaryMissing())) {
					process.stderr.write(
						"\nclaude's native binary is missing. Run 'codevhub install' to repair it " +
							"(reinstalls Claude Code with the platform binary included).\n",
					);
				} else if (
					stubbedAgent === "codev" &&
					(await codevNativeBinaryMissing())
				) {
					process.stderr.write(
						"\nCoDev Code's native binary is missing — bin/codev.exe is still the " +
							"placeholder stub, which is why it won't start. Run 'codevhub install' " +
							"to repair it (re-runs the postinstall and reinstalls the platform binary).\n",
					);
				}
				(code === 0 ? logInfo : logWarn)(`${label} exited (code ${code})`, {
					action: "process.exit",
					eventType: "end",
					outcome: code === 0 ? "success" : "failure",
					extra: { agent: cmd, exit_code: code },
				});
				resolve(code);
				return;
			}
			const signo = signal ? (constants.signals[signal] ?? 0) : 0;
			logWarn(`${label} exited (signal ${signal})`, {
				action: "process.exit",
				eventType: "end",
				outcome: "failure",
				extra: { agent: cmd, exit_code: 128 + signo, signal },
			});
			resolve(128 + signo);
		});
	});
}
