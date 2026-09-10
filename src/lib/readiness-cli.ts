import {
	READINESS_AGENTS,
	type ReadinessAgent,
} from "@/lib/readiness-agent.js";

export interface ReadinessCliOptions {
	model?: string;
	profile?: string;
	agent?: ReadinessAgent;
}

export function parseReadinessArgs(args: string[]): ReadinessCliOptions {
	const parsed: ReadinessCliOptions = {};
	for (let index = 0; index < args.length; index++) {
		const raw = args[index] ?? "";
		const equal = raw.indexOf("=");
		const flag = equal >= 0 ? raw.slice(0, equal) : raw;
		const inline = equal >= 0 ? raw.slice(equal + 1) : undefined;
		if (!["--model", "--profile", "--agent"].includes(flag))
			throw new Error(`Unknown readiness option: ${raw}.`);
		const value = inline ?? args[++index];
		if (!value || value.startsWith("--"))
			throw new Error(`Missing value for ${flag}.`);
		const field = flag.slice(2) as keyof ReadinessCliOptions;
		if (parsed[field]) throw new Error(`Duplicate readiness option: ${flag}.`);
		if (field === "agent") {
			if (!(READINESS_AGENTS as readonly string[]).includes(value))
				throw new Error(`Unknown readiness agent: ${value}.`);
			parsed.agent = value as ReadinessAgent;
		} else parsed[field] = value;
	}
	if (parsed.agent === "opencode" && parsed.model)
		throw new Error("--model cannot be used with OpenCode readiness runs.");
	return parsed;
}
