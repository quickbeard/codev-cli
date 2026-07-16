import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ReadinessProfile } from "@/lib/readiness-profile.js";

interface ReadinessProfileSelectProps {
	profiles: ReadinessProfile[];
	selected?: ReadinessProfile | null;
	readOnly?: boolean;
	onSelect: (profile: ReadinessProfile) => void;
}

export function ReadinessProfileSelect({
	profiles,
	selected = null,
	readOnly = false,
	onSelect,
}: ReadinessProfileSelectProps) {
	const [cursor, setCursor] = useState(0);
	useInput(
		(_input, key) => {
			if (key.upArrow || key.downArrow) {
				const direction = key.upArrow ? -1 : 1;
				setCursor(
					(current) =>
						(current + direction + profiles.length) % profiles.length,
				);
			} else if (key.return) {
				const choice = profiles[cursor];
				if (choice) onSelect(choice);
			}
		},
		{ isActive: !readOnly && profiles.length > 0 },
	);
	return (
		<Box flexDirection="column">
			{profiles.map((profile, index) => {
				const chosen = selected?.activeVersion.id === profile.activeVersion.id;
				return (
					<Box key={profile.activeVersion.id}>
						<Text color={chosen ? "green" : undefined}>
							{chosen ? "●" : "○"}
						</Text>
						<Text> </Text>
						<Text
							bold={!readOnly && cursor === index}
							dimColor={readOnly && !chosen}
						>
							{profile.name} r{profile.activeVersion.revision}
							{profile.isDefault ? " (default)" : ""}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

export function readinessProfileSelectTitle(readOnly = false) {
	return (
		<Text bold>
			{"Choose readiness profile "}
			{!readOnly && <Text dimColor>(↑/↓ to move, Enter to confirm)</Text>}
		</Text>
	);
}
