import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import * as auth from "@/auth.js";
import { Login } from "@/components/Login.js";
import * as proxy from "@/proxy.js";

afterEach(() => {
	cleanup();
});

describe("Login", () => {
	test("renders step 2/2 header", () => {
		spyOn(auth, "login").mockImplementation(() => new Promise(() => {}));
		const onDone = mock();
		const { lastFrame } = render(<Login onDone={onDone} />);

		const output = lastFrame() ?? "";
		expect(output).toContain("Step 2/2");
		expect(output).toContain("Login to Viettel SSO");
	});

	test("shows 'Press Enter' when onReady is called", async () => {
		spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(() => {});
			return new Promise(() => {});
		});

		const onDone = mock();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("Press Enter to open the browser and login");
	});

	test("shows log messages from login", async () => {
		spyOn(auth, "login").mockImplementation((onLog) => {
			onLog("Starting SSO login...");
			onLog("Already logged in as test@viettel.com.vn");
			return Promise.resolve({
				access_token: "t",
				id_token: "i",
				expires_at: Date.now() + 3600000,
				user: { sub: "u", email: "test@viettel.com.vn", displayName: "Test" },
			});
		});

		const onDone = mock();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("Starting SSO login...");
		expect(output).toContain("Already logged in as test@viettel.com.vn");
	});

	test("shows error message on login failure", async () => {
		spyOn(auth, "login").mockImplementation(() => {
			return Promise.reject(new Error("Connection refused"));
		});

		const onDone = mock();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("Login failed: Connection refused");
	});

	test("opens browser when Enter is pressed", async () => {
		const openBrowserFn = mock();
		spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(openBrowserFn);
			return new Promise(() => {});
		});

		const onDone = mock();
		const { stdin } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(openBrowserFn).toHaveBeenCalled();
	});

	test("does not open browser before Enter is pressed", async () => {
		const openBrowserFn = mock();
		spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(openBrowserFn);
			return new Promise(() => {});
		});

		const onDone = mock();
		render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		expect(openBrowserFn).not.toHaveBeenCalled();
	});

	test("shows API key and Happy coding after successful exchange", async () => {
		spyOn(auth, "login").mockImplementation(() =>
			Promise.resolve({
				access_token: "access-xyz",
				id_token: "id-xyz",
				expires_at: Date.now() + 3600000,
				user: { sub: "u", email: "test@viettel.com.vn", displayName: "Test" },
			}),
		);
		spyOn(proxy, "fetchApiKey").mockResolvedValue("sk-test-key-123");

		const onDone = mock();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 100));

		const output = lastFrame() ?? "";
		expect(output).toContain("sk-test-key-123");
		expect(output).toContain("Happy coding!");
	});

	test("calls onDone roughly 1 second after API key is shown", async () => {
		spyOn(auth, "login").mockImplementation(() =>
			Promise.resolve({
				access_token: "access-xyz",
				id_token: "id-xyz",
				expires_at: Date.now() + 3600000,
				user: { sub: "u", email: "test@viettel.com.vn", displayName: "Test" },
			}),
		);
		spyOn(proxy, "fetchApiKey").mockResolvedValue("sk-test-key-123");

		const onDone = mock();
		render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 500));
		expect(onDone).not.toHaveBeenCalled();

		await new Promise((r) => setTimeout(r, 700));
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	test("shows error if proxy key exchange fails", async () => {
		spyOn(auth, "login").mockImplementation(() =>
			Promise.resolve({
				access_token: "access-xyz",
				id_token: "id-xyz",
				expires_at: Date.now() + 3600000,
				user: { sub: "u", email: "test@viettel.com.vn", displayName: "Test" },
			}),
		);
		spyOn(proxy, "fetchApiKey").mockRejectedValue(
			new Error("Proxy /auth/exchange failed (502): boom"),
		);

		const onDone = mock();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 100));

		const output = lastFrame() ?? "";
		expect(output).toContain("Login failed: Proxy /auth/exchange failed");
		expect(onDone).not.toHaveBeenCalled();
	});
});
