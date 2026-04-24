import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import * as auth from "@/auth.js";
import { Login } from "@/components/Login.js";
import * as proxy from "@/proxy.js";

afterEach(() => {
	cleanup();
});

describe("Login", () => {
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
			onLog("Already logged in as test@example.com");
			return Promise.resolve({
				access_token: "t",
				id_token: "i",
				expires_at: Date.now() + 3600000,
				user: { sub: "u", email: "test@example.com", displayName: "Test" },
			});
		});

		const onDone = mock();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("Starting SSO login...");
		expect(output).toContain("Already logged in as test@example.com");
	});

	test("shows error and retry prompt on login failure", async () => {
		spyOn(auth, "login").mockImplementation(() => {
			return Promise.reject(new Error("Connection refused"));
		});

		const onDone = mock();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("Login failed: Connection refused");
		expect(output).toContain("Press Enter to retry, Ctrl-C to quit");
		expect(onDone).not.toHaveBeenCalled();
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

	test("calls onDone with the api key after successful exchange", async () => {
		spyOn(auth, "login").mockImplementation(() =>
			Promise.resolve({
				access_token: "access-xyz",
				id_token: "id-xyz",
				expires_at: Date.now() + 3600000,
				user: { sub: "u", email: "test@example.com", displayName: "Test" },
			}),
		);
		spyOn(proxy, "fetchApiKey").mockResolvedValue("sk-test-key-123");

		const onDone = mock();
		render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 100));

		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith("sk-test-key-123");
	});

	test("shows error and retry prompt if proxy key exchange fails", async () => {
		spyOn(auth, "login").mockImplementation(() =>
			Promise.resolve({
				access_token: "access-xyz",
				id_token: "id-xyz",
				expires_at: Date.now() + 3600000,
				user: { sub: "u", email: "test@example.com", displayName: "Test" },
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
		expect(output).toContain("Press Enter to retry, Ctrl-C to quit");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("retries on Enter after a failure and succeeds on the second attempt", async () => {
		const loginSpy = spyOn(auth, "login").mockImplementation(() =>
			Promise.resolve({
				access_token: "access-xyz",
				id_token: "id-xyz",
				expires_at: Date.now() + 3600000,
				user: { sub: "u", email: "test@example.com", displayName: "Test" },
			}),
		);
		const fetchSpy = spyOn(proxy, "fetchApiKey")
			.mockImplementationOnce(() => Promise.reject(new Error("transient")))
			.mockImplementationOnce(() => Promise.resolve("sk-retry-ok"));
		// bun's spyOn retains call counts across tests in the same file; clear
		// them so the per-test "called twice" assertion counts only this test.
		loginSpy.mockClear();
		fetchSpy.mockClear();

		const onDone = mock();
		const { stdin, lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 100));
		expect(lastFrame() ?? "").toContain("Login failed: transient");
		expect(onDone).not.toHaveBeenCalled();

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 100));

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(loginSpy).toHaveBeenCalledTimes(2);
		expect(onDone).toHaveBeenCalledWith("sk-retry-ok");
	});

	test("clears the previous error and logs when retrying", async () => {
		spyOn(auth, "login")
			.mockImplementationOnce((onLog) => {
				onLog("first attempt log");
				return Promise.reject(new Error("boom"));
			})
			.mockImplementationOnce((_onLog, onReady) => {
				onReady(() => {});
				return new Promise(() => {});
			});

		const onDone = mock();
		const { stdin, lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));
		expect(lastFrame() ?? "").toContain("first attempt log");
		expect(lastFrame() ?? "").toContain("Login failed: boom");

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		const after = lastFrame() ?? "";
		expect(after).not.toContain("first attempt log");
		expect(after).not.toContain("Login failed: boom");
		expect(after).not.toContain("Press Enter to retry");
	});
});
