import { Box, Text } from "ink";
import type { ReactNode } from "react";

interface FrameProps {
	tag: string;
	children: ReactNode;
}

export function Frame({ tag, children }: FrameProps) {
	return (
		<Box flexDirection="column">
			<Box>
				<Text color="gray">┌</Text>
				<Text backgroundColor="cyan" color="black" bold>
					{` ${tag} `}
				</Text>
			</Box>
			{children}
		</Box>
	);
}
