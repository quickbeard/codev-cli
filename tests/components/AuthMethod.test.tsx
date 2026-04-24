import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { AuthMethod } from "@/components/AuthMethod.js";

const DOWN = `${String.fromCharCode(27)}[B`;
const UP = `${String.fromCharCode(27)}[A`;

afterEach(() => {
	cleanup();
});

describe("AuthMethod", () => {
	test("renders both options", () => {
		const onSelect = mock();
		const { lastFrame } = render(<AuthMethod onSelect={onSelect} />);
		const output = lastFrame() ?? "";
		expect(output).toContain("Login to SSO");
		expect(output).toContain("I have my own API Key");
	});

	test("Enter picks SSO (default cursor at index 0)", async () => {
		const onSelect = mock();
		const { stdin } = render(<AuthMethod onSelect={onSelect} />);

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith("sso");
	});

	test("down arrow + Enter picks manual", async () => {
		const onSelect = mock();
		const { stdin } = render(<AuthMethod onSelect={onSelect} />);

		stdin.write(DOWN);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith("manual");
	});

	test("down then up returns cursor to SSO", async () => {
		const onSelect = mock();
		const { stdin } = render(<AuthMethod onSelect={onSelect} />);

		stdin.write(DOWN);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write(UP);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledWith("sso");
	});

	test("down arrow does not move past the last option", async () => {
		const onSelect = mock();
		const { stdin } = render(<AuthMethod onSelect={onSelect} />);

		// Press down many times — cursor should clamp at the last option.
		for (let i = 0; i < 5; i++) {
			stdin.write(DOWN);
			await new Promise((r) => setTimeout(r, 10));
		}
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledWith("manual");
	});

	test("readOnly ignores keyboard input", async () => {
		const onSelect = mock();
		const { stdin } = render(
			<AuthMethod onSelect={onSelect} readOnly={true} />,
		);

		stdin.write(DOWN);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).not.toHaveBeenCalled();
	});

	test("renders the selected option with a filled marker", () => {
		const onSelect = mock();
		const { lastFrame } = render(
			<AuthMethod onSelect={onSelect} selected="manual" readOnly={true} />,
		);
		const output = lastFrame() ?? "";
		// The selected option gets "●"; unchosen options get "○".
		const manualLineHasFilled = output
			.split("\n")
			.some((line) => line.includes("●") && line.includes("I have my own"));
		expect(manualLineHasFilled).toBe(true);
	});
});
