import { restoreTool, type Tool } from "@/configure.js";

export function runRestore(tool: Tool): number {
	const result = restoreTool(tool);
	if (result.status === "no-backup") {
		console.error(`No backup found at ${result.backupPath}.`);
		return 1;
	}
	console.log(`Restored ${result.sourcePath} from ${result.backupPath}.`);
	return 0;
}
