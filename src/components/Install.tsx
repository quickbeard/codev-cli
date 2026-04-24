import { TaskList } from "@/components/TaskList.js";
import type { Tool } from "@/configure.js";
import { installAndVerify, PKG } from "@/npm.js";

interface InstallProps {
	tools: Tool[];
	onDone: (success: boolean) => void;
}

export function Install({ tools, onDone }: InstallProps) {
	const tasks = tools.map((tool) => ({
		key: tool,
		label: PKG[tool],
		run: () => installAndVerify(tool),
	}));
	return (
		<TaskList
			tasks={tasks}
			verb={{ infinitive: "install", present: "Installing", past: "Installed" }}
			onDone={onDone}
		/>
	);
}
