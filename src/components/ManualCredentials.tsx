import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface ManualCredentialsValue {
	baseUrl: string;
	apiKey: string;
	model: string;
}

interface ManualCredentialsProps {
	onDone: (creds: ManualCredentialsValue) => void;
	readOnly?: boolean;
}

const FIELDS = [
	{ key: "baseUrl" as const, label: "API URL" },
	{ key: "apiKey" as const, label: "API Key" },
	{ key: "model" as const, label: "Model" },
];

const LABEL_WIDTH = Math.max(...FIELDS.map((f) => f.label.length));

type Values = Record<(typeof FIELDS)[number]["key"], string>;

export function ManualCredentials({
	onDone,
	readOnly = false,
}: ManualCredentialsProps) {
	const [values, setValues] = useState<Values>({
		baseUrl: "",
		apiKey: "",
		model: "",
	});
	const [index, setIndex] = useState(0);
	const [submitted, setSubmitted] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useInput(
		(input, key) => {
			if (submitted) return;

			const current = FIELDS[index];
			if (!current) return;

			if (key.return) {
				const value = values[current.key].trim();
				if (!value) {
					setError(`${current.label} is required`);
					return;
				}
				setError(null);
				if (index < FIELDS.length - 1) {
					setIndex(index + 1);
					return;
				}
				setSubmitted(true);
				onDone({
					baseUrl: values.baseUrl.trim(),
					apiKey: values.apiKey.trim(),
					model: values.model.trim(),
				});
				return;
			}

			if (key.backspace || key.delete) {
				setValues((prev) => ({
					...prev,
					[current.key]: prev[current.key].slice(0, -1),
				}));
				return;
			}

			// Ignore other control keys (arrows, tab, escape, etc.) so they don't
			// leak raw escape sequences into the field.
			if (key.ctrl || key.meta || key.escape) return;
			if (!input) return;

			// Strip newlines from pasted input; everything else (including spaces)
			// goes through so users can paste keys that contain unusual chars.
			const cleaned = input.replace(/[\r\n]/g, "");
			if (!cleaned) return;

			setValues((prev) => ({
				...prev,
				[current.key]: prev[current.key] + cleaned,
			}));
		},
		{ isActive: !readOnly && !submitted },
	);

	return (
		<Box flexDirection="column">
			{FIELDS.map((field, i) => {
				const isActive = !readOnly && !submitted && i === index;
				const isPast = submitted || i < index;
				const value = values[field.key];
				const label = field.label.padEnd(LABEL_WIDTH, " ");
				return (
					<Box key={field.key}>
						<Text color={isActive ? "cyan" : undefined} dimColor={!isActive}>
							{`${label}: `}
						</Text>
						<Text>{value}</Text>
						{isActive && <Text color="cyan">▌</Text>}
						{isPast && !value && <Text dimColor>(empty)</Text>}
					</Box>
				);
			})}
			{error && !submitted && (
				<Box marginTop={1}>
					<Text color="red">{error}</Text>
				</Box>
			)}
			{!readOnly && !submitted && (
				<Box marginTop={1}>
					<Text dimColor>
						{
							"Press Enter to confirm each field. Backspace to edit the current field."
						}
					</Text>
				</Box>
			)}
		</Box>
	);
}

export function manualCredentialsTitle() {
	return <Text bold>{"Enter API credentials"}</Text>;
}
