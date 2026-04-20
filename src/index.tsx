#!/usr/bin/env node
import { render } from "ink";
import { App } from "@/App.js";
import { logout } from "@/auth.js";

const command = process.argv[2];

if (command === "logout") {
	if (logout()) {
		console.log("Logged out.");
	} else {
		console.log("Not logged in.");
	}
	process.exit(0);
}

render(<App />);
