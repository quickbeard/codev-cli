#!/usr/bin/env node
import { render } from "ink";
import { App } from "@/App.js";
import { logout } from "@/auth.js";

const command = process.argv[2];

if (command === "logout") {
	const ok = await logout();
	console.log(ok ? "Logged out." : "Not logged in.");
	process.exit(0);
}

const { waitUntilExit } = render(<App />);
await waitUntilExit();
process.exit(0);
