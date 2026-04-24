import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { ManualCredentials } from "@/components/ManualCredentials.js";

const BACKSPACE = String.fromCharCode(127);

async function tick() {
	await new Promise((r) => setTimeout(r, 30));
}

afterEach(() => {
	cleanup();
});

describe("ManualCredentials", () => {
	test("renders all three field labels", () => {
		const onDone = mock();
		const { lastFrame } = render(<ManualCredentials onDone={onDone} />);
		const output = lastFrame() ?? "";
		expect(output).toContain("API URL");
		expect(output).toContain("API Key");
		expect(output).toContain("Model");
	});

	test("typed characters appear in the active field", async () => {
		const onDone = mock();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("https://example.com/v1");
		await tick();

		expect(lastFrame() ?? "").toContain("https://example.com/v1");
	});

	test("Enter advances through all three fields and submits", async () => {
		const onDone = mock();
		const { stdin } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("https://example.com/v1");
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("sk-test");
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("my-model");
		await tick();
		stdin.write("\r");
		await tick();

		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith({
			baseUrl: "https://example.com/v1",
			apiKey: "sk-test",
			model: "my-model",
		});
	});

	test("trims surrounding whitespace from submitted values", async () => {
		const onDone = mock();
		const { stdin } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("  https://example.com  ");
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write(" sk-key ");
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write(" some-model ");
		await tick();
		stdin.write("\r");
		await tick();

		expect(onDone).toHaveBeenCalledWith({
			baseUrl: "https://example.com",
			apiKey: "sk-key",
			model: "some-model",
		});
	});

	test("Enter on an empty field shows an error and does not advance", async () => {
		const onDone = mock();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("\r");
		await tick();

		const output = lastFrame() ?? "";
		expect(output).toContain("API URL is required");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("Enter on an all-whitespace field shows the required error", async () => {
		const onDone = mock();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("   ");
		await tick();
		stdin.write("\r");
		await tick();

		const output = lastFrame() ?? "";
		expect(output).toContain("API URL is required");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("backspace removes the last character of the active field", async () => {
		const onDone = mock();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("abc");
		await tick();
		stdin.write(BACKSPACE);
		await tick();

		const output = lastFrame() ?? "";
		expect(output).toContain("ab");
		// The trailing "c" should no longer appear on the API URL line.
		const urlLine = output.split("\n").find((l) => l.includes("API URL"));
		expect(urlLine).toBeDefined();
		expect(urlLine).not.toMatch(/abc/);
	});

	test("does not advance past the required error until user types a value", async () => {
		const onDone = mock();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		// Empty Enter -> error
		stdin.write("\r");
		await tick();
		expect(lastFrame() ?? "").toContain("API URL is required");

		// Now type and Enter -> advances to API Key, error should clear
		stdin.write("https://x");
		await tick();
		stdin.write("\r");
		await tick();

		// Another empty Enter on API Key should show its own required error
		stdin.write("\r");
		await tick();
		expect(lastFrame() ?? "").toContain("API Key is required");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("readOnly ignores all keyboard input", async () => {
		const onDone = mock();
		const { stdin, lastFrame } = render(
			<ManualCredentials onDone={onDone} readOnly={true} />,
		);

		stdin.write("hello");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame() ?? "").not.toContain("hello");
		expect(onDone).not.toHaveBeenCalled();
	});
});
