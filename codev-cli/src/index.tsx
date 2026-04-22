#!/usr/bin/env node
import { render } from "ink";
import { App } from "@/App.js";
import { logout } from "@/auth.js";
import { printHelp } from "@/help.js";
import { runAgent } from "@/run.js";

const [command, ...args] = process.argv.slice(2);

switch (command) {
	case undefined:
	case "--help":
	case "-h":
	case "help":
		printHelp();
		process.exit(0);
		break;
	case "install": {
		const { waitUntilExit } = render(<App />);
		await waitUntilExit();
		process.exit(0);
		break;
	}
	case "logout": {
		const ok = await logout();
		console.log(ok ? "Logged out." : "Not logged in.");
		process.exit(0);
		break;
	}
	case "claude":
		process.exit(await runAgent("claude", args));
		break;
	case "opencode":
		process.exit(await runAgent("opencode", args));
		break;
	default:
		console.error(`Unknown command: ${command}\n`);
		printHelp();
		process.exit(1);
}
