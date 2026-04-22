import { Box, Text } from "ink";
import type { ReactNode } from "react";

interface StepProps {
	active?: boolean;
	title: ReactNode;
	children?: ReactNode;
}

export function Step({ active = false, title, children }: StepProps) {
	const mark = active ? "◆" : "◇";
	const markColor = active ? "cyan" : "gray";
	return (
		<Box flexDirection="column">
			<Box>
				<Text color="gray">│</Text>
			</Box>
			<Box>
				<Text color={markColor} bold>
					{mark}
				</Text>
				<Text>{"  "}</Text>
				<Box>{title}</Box>
			</Box>
			{children && (
				<Box
					flexDirection="column"
					borderStyle="single"
					borderLeft
					borderRight={false}
					borderTop={false}
					borderBottom={false}
					borderColor="gray"
					paddingLeft={2}
				>
					{children}
				</Box>
			)}
		</Box>
	);
}
