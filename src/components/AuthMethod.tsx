import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type AuthMethodChoice = "sso" | "manual";

const OPTIONS: { label: string; value: AuthMethodChoice }[] = [
	{ label: "Login to SSO", value: "sso" },
	{ label: "I have my own API Key", value: "manual" },
];

interface AuthMethodProps {
	onSelect: (choice: AuthMethodChoice) => void;
	readOnly?: boolean;
	selected?: AuthMethodChoice | null;
}

export function AuthMethod({
	onSelect,
	readOnly = false,
	selected = null,
}: AuthMethodProps) {
	const [cursor, setCursor] = useState(0);

	useInput(
		(_input, key) => {
			if (key.upArrow) {
				setCursor((c) => Math.max(0, c - 1));
			} else if (key.downArrow) {
				setCursor((c) => Math.min(OPTIONS.length - 1, c + 1));
			} else if (key.return) {
				const option = OPTIONS[cursor];
				if (option) onSelect(option.value);
			}
		},
		{ isActive: !readOnly },
	);

	return (
		<Box flexDirection="column">
			{OPTIONS.map((option, i) => {
				const isChosen = selected === option.value;
				const isCursor = !readOnly && cursor === i;
				return (
					<Box key={option.value}>
						<Text color={isChosen ? "green" : undefined}>
							{isChosen ? "●" : isCursor ? "○" : "○"}
						</Text>
						<Text> </Text>
						<Text bold={isCursor} dimColor={!isCursor && !isChosen}>
							{option.label}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

export function authMethodTitle(readOnly = false) {
	return (
		<Text bold>
			{"Choose authentication method "}
			{!readOnly && <Text dimColor>(↑/↓ to move, press Enter to confirm)</Text>}
		</Text>
	);
}
