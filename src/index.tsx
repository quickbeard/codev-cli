#!/usr/bin/env node
import { render } from "ink";
import { App } from "@/App.js";
import { logout } from "@/auth.js";
import { printHelp, printVersion } from "@/help.js";
import { runRestore } from "@/restore.js";
import { runAgent } from "@/run.js";
import { UpdateApp } from "@/UpdateApp.js";

const MIN_NODE_MAJOR = 22;
const nodeMajor = Number.parseInt(
	process.versions.node.split(".")[0] ?? "0",
	10,
);
if (Number.isNaN(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
	console.error(
		`CoDev requires Node.js >= ${MIN_NODE_MAJOR}. Current version: ${process.versions.node}.`,
	);
	process.exit(1);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
	case undefined:
	case "--help":
	case "-h":
	case "help":
		printHelp();
		process.exit(0);
		break;
	case "--version":
	case "-v":
	case "version":
		printVersion();
		process.exit(0);
		break;
	case "install": {
		const { waitUntilExit } = render(<App />);
		await waitUntilExit();
		process.exit(0);
		break;
	}
	case "update": {
		const { waitUntilExit } = render(<UpdateApp />);
		try {
			await waitUntilExit();
			process.exit(0);
		} catch {
			process.exit(1);
		}
		break;
	}
	case "logout": {
		const ok = await logout();
		console.log(ok ? "Logged out." : "Not logged in.");
		process.exit(0);
		break;
	}
	case "claude":
		if (args[0] === "--restore") {
			process.exit(runRestore("claude-code"));
		}
		process.exit(await runAgent("claude", args));
		break;
	case "codex":
		if (args[0] === "--restore") {
			process.exit(runRestore("codex"));
		}
		process.exit(await runAgent("codex", args));
		break;
	case "opencode":
		if (args[0] === "--restore") {
			process.exit(runRestore("opencode"));
		}
		process.exit(await runAgent("opencode", args));
		break;
	default:
		console.error(`Unknown command: ${command}\n`);
		printHelp();
		process.exit(1);
}
