import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-shims-test-"));
	vi.stubEnv("HOME", tempDir);
	vi.stubEnv("USERPROFILE", tempDir);
	// configureClaudeCode (exercised below) falls back to AI_GATEWAY_URL() when
	// creds carry no baseUrl; that reads gateway_url from ~/.codev-hub/auth.json.
	mkdirSync(join(tempDir, ".codev-hub"), { recursive: true });
	writeFileSync(
		join(tempDir, ".codev-hub", "auth.json"),
		JSON.stringify({ gateway_url: "https://gw.test/gateway" }),
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

function withPlatform<T>(value: NodeJS.Platform, fn: () => T): T {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		value,
		configurable: true,
	});
	try {
		return fn();
	} finally {
		if (original) Object.defineProperty(process, "platform", original);
	}
}

describe("shimDir", () => {
	test("resolves under $HOME/.codev-hub/bin", async () => {
		const { shimDir } = await import("@/lib/shims.js");
		expect(shimDir()).toBe(join(tempDir, ".codev-hub", "bin"));
	});
});

describe("toolToShimAgent", () => {
	test("maps claude-code to claude and the others 1:1", async () => {
		const { toolToShimAgent } = await import("@/lib/shims.js");
		expect(toolToShimAgent("claude-code")).toBe("claude");
		expect(toolToShimAgent("codex")).toBe("codex");
		expect(toolToShimAgent("opencode")).toBe("opencode");
		expect(toolToShimAgent("codev-code")).toBe("codev");
	});
});

describe("detectCodevTools", () => {
	function seedBackup(relPath: string) {
		const path = join(tempDir, relPath);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "");
	}

	test("returns [] when no tool backups exist", async () => {
		const { detectCodevTools } = await import("@/lib/shims.js");
		expect(detectCodevTools()).toEqual([]);
	});

	test("returns only the agents whose *.backup exists, mapping claude-code → claude", async () => {
		seedBackup(".claude/settings.json.backup");
		seedBackup(".codex/config.toml.backup");

		const { detectCodevTools } = await import("@/lib/shims.js");
		expect(detectCodevTools().sort()).toEqual(["claude", "codex"]);
	});

	test("includes opencode when its nested backup exists", async () => {
		seedBackup(".config/opencode/opencode.json.backup");

		const { detectCodevTools } = await import("@/lib/shims.js");
		expect(detectCodevTools()).toEqual(["opencode"]);
	});

	test("includes a tool whose live config has CoDev's marker even without a backup", async () => {
		// First-time user: no pre-existing config means `ensureBackup` has nothing
		// to snapshot, so no `*.backup` is ever created. The live config still
		// carries CoDev's marker keys though — that signal must be honored.
		const { configureClaudeCode } = await import("@/lib/configure.js");
		configureClaudeCode({ apiKey: "sk-test", model: "test-model" });

		expect(existsSync(join(tempDir, ".claude", "settings.json.backup"))).toBe(
			false,
		);

		const { detectCodevTools } = await import("@/lib/shims.js");
		expect(detectCodevTools()).toEqual(["claude"]);
	});
});

describe("activationHint", () => {
	test("returns the exec $SHELL hint on Unix platforms", async () => {
		const { activationHint } = await import("@/lib/shims.js");
		// darwin is what the CI runner and the dev's macOS report.
		const msg = withPlatform("darwin", activationHint);
		expect(msg).toBe("Run `exec $SHELL` to apply (or open a new terminal).");
		const linux = withPlatform("linux", activationHint);
		expect(linux).toBe(msg);
	});

	test("returns the restart-terminal hint on Windows", async () => {
		const { activationHint } = await import("@/lib/shims.js");
		const msg = withPlatform("win32", activationHint);
		expect(msg).toBe("Restart your terminal to apply.");
	});

	test("does not mention exec or $SHELL on Windows", async () => {
		// exec/$SHELL don't exist on PowerShell or cmd, so the Windows hint must
		// avoid that jargon entirely.
		const { activationHint } = await import("@/lib/shims.js");
		const msg = withPlatform("win32", activationHint);
		expect(msg).not.toMatch(/exec|\$SHELL/);
	});
});

describe("stripShimDirFromPath", () => {
	// Skipped on Windows: shimDir() returns a path with a drive-letter colon
	// (e.g. `C:\Users\…\.codev-hub\bin`), which would split into pieces under the
	// `":"` delimiter and never match. The next test (platform default delimiter)
	// covers Windows.
	test.skipIf(process.platform === "win32")(
		"removes the shim dir entry from a colon-separated PATH",
		async () => {
			const { shimDir, stripShimDirFromPath } = await import("@/lib/shims.js");
			const dir = shimDir();
			const path = ["/usr/local/bin", dir, "/usr/bin"].join(":");
			expect(stripShimDirFromPath(path, ":")).toBe("/usr/local/bin:/usr/bin");
		},
	);

	test("returns the input untouched when shim dir is absent", async () => {
		const { stripShimDirFromPath } = await import("@/lib/shims.js");
		expect(stripShimDirFromPath("/usr/local/bin:/usr/bin", ":")).toBe(
			"/usr/local/bin:/usr/bin",
		);
	});

	test("handles undefined PATH", async () => {
		const { stripShimDirFromPath } = await import("@/lib/shims.js");
		expect(stripShimDirFromPath(undefined, ":")).toBe("");
	});

	test("uses the platform delimiter by default", async () => {
		const { shimDir, stripShimDirFromPath } = await import("@/lib/shims.js");
		const dir = shimDir();
		const path = ["/usr/local/bin", dir, "/usr/bin"].join(delimiter);
		expect(stripShimDirFromPath(path)).toBe(
			["/usr/local/bin", "/usr/bin"].join(delimiter),
		);
	});

	test.skipIf(process.platform === "win32")(
		"also strips the legacy ~/.codev/bin shim dir from pre-0.4 installs",
		async () => {
			const { stripShimDirFromPath } = await import("@/lib/shims.js");
			const legacy = join(tempDir, ".codev", "bin");
			const path = ["/usr/local/bin", legacy, "/usr/bin"].join(":");
			expect(stripShimDirFromPath(path, ":")).toBe("/usr/local/bin:/usr/bin");
		},
	);

	test.skipIf(process.platform === "win32")(
		"strips both current and legacy shim dirs simultaneously",
		async () => {
			const { shimDir, stripShimDirFromPath } = await import("@/lib/shims.js");
			const dir = shimDir();
			const legacy = join(tempDir, ".codev", "bin");
			const path = [dir, "/usr/bin", legacy, "/usr/local/bin"].join(":");
			expect(stripShimDirFromPath(path, ":")).toBe("/usr/bin:/usr/local/bin");
		},
	);
});

describe.skipIf(process.platform === "win32")("installShims (Unix)", () => {
	test("writes executable POSIX shims that forward to `codevhub <agent>`", async () => {
		const { installShims } = await import("@/lib/shims.js");
		const result = installShims();

		expect(result.shimsWritten.sort()).toEqual([
			"claude",
			"codev",
			"codex",
			"opencode",
		]);
		for (const agent of ["claude", "codev", "codex", "opencode"]) {
			const path = join(tempDir, ".codev-hub", "bin", agent);
			expect(existsSync(path)).toBe(true);
			const contents = readFileSync(path, "utf-8");
			expect(contents).toMatch(/^#!\/bin\/sh\b/);
			expect(contents).toContain(`exec codevhub ${agent} "$@"`);
			// chmod +x — at least the owner-execute bit
			expect(statSync(path).mode & 0o100).toBe(0o100);
		}
	});

	test("updates ~/.zshrc, ~/.bashrc, ~/.bash_profile with PATH prepend + aliases", async () => {
		const { installShims } = await import("@/lib/shims.js");
		const result = installShims();

		for (const name of [".zshrc", ".bashrc", ".bash_profile"]) {
			const path = join(tempDir, name);
			expect(result.rcFilesUpdated).toContain(path);
			const contents = readFileSync(path, "utf-8");
			expect(contents).toContain("# >>> codev shims (managed) >>>");
			expect(contents).toContain("# <<< codev shims (managed) <<<");
			expect(contents).toContain('export PATH="$HOME/.codev-hub/bin:$PATH"');
			expect(contents).toContain('alias claude="$HOME/.codev-hub/bin/claude"');
			expect(contents).toContain('alias codex="$HOME/.codev-hub/bin/codex"');
			expect(contents).toContain(
				'alias opencode="$HOME/.codev-hub/bin/opencode"',
			);
			expect(contents).toContain('alias codev="$HOME/.codev-hub/bin/codev"');
		}
	});

	test("guards every rc alias on the shim file existing", async () => {
		// A live shell can hold the alias after the shim is gone (`codevhub
		// unhook` in another terminal). An unguarded alias to the absolute shim
		// path then breaks the command with "no such file or directory"; the
		// guard lets the shell fall back to the real binary on PATH instead.
		const { installShims } = await import("@/lib/shims.js");
		installShims();

		const zshrc = readFileSync(join(tempDir, ".zshrc"), "utf-8");
		for (const agent of ["claude", "codev", "codex", "opencode"]) {
			expect(zshrc).toContain(
				`[ -x "$HOME/.codev-hub/bin/${agent}" ] && alias ${agent}="$HOME/.codev-hub/bin/${agent}"`,
			);
		}
	});

	test("preserves user content in existing rc files", async () => {
		const zshrc = join(tempDir, ".zshrc");
		writeFileSync(zshrc, "export FOO=bar\nalias ll='ls -la'\n");

		const { installShims } = await import("@/lib/shims.js");
		installShims();

		const contents = readFileSync(zshrc, "utf-8");
		expect(contents).toContain("export FOO=bar");
		expect(contents).toContain("alias ll='ls -la'");
		expect(contents).toContain("# >>> codev shims (managed) >>>");
	});

	test("re-running replaces the sentinel block in place (idempotent)", async () => {
		const { installShims } = await import("@/lib/shims.js");
		installShims();
		installShims();

		const zshrc = readFileSync(join(tempDir, ".zshrc"), "utf-8");
		const startCount =
			zshrc.split("# >>> codev shims (managed) >>>").length - 1;
		const endCount = zshrc.split("# <<< codev shims (managed) <<<").length - 1;
		expect(startCount).toBe(1);
		expect(endCount).toBe(1);
	});

	test("updates fish config only when ~/.config/fish/ exists", async () => {
		// First run: no fish dir → fish config should not be created.
		const { installShims } = await import("@/lib/shims.js");
		const noFish = installShims();
		const fishPath = join(tempDir, ".config", "fish", "config.fish");
		expect(existsSync(fishPath)).toBe(false);
		expect(noFish.rcFilesUpdated).not.toContain(fishPath);

		// Second run after creating fish dir: now it should write.
		mkdirSync(join(tempDir, ".config", "fish"), { recursive: true });
		const withFish = installShims();
		expect(existsSync(fishPath)).toBe(true);
		expect(withFish.rcFilesUpdated).toContain(fishPath);
		const contents = readFileSync(fishPath, "utf-8");
		expect(contents).toContain("fish_add_path -p $HOME/.codev-hub/bin");
		expect(contents).toContain(
			'test -x "$HOME/.codev-hub/bin/claude"; and alias claude "$HOME/.codev-hub/bin/claude"',
		);
	});

	test("does not touch the Windows PowerShell profile path on Unix", async () => {
		const { installShims } = await import("@/lib/shims.js");
		installShims();
		expect(
			existsSync(
				join(
					tempDir,
					"Documents",
					"PowerShell",
					"Microsoft.PowerShell_profile.ps1",
				),
			),
		).toBe(false);
	});

	test("shim strips its own dir from PATH before exec'ing codevhub", async () => {
		// The shim itself must filter out ~/.codev-hub/bin from PATH so that older
		// hub versions (which don't filter their own shim dir) can't loop back
		// through this script when they spawn the real agent binary.
		const { installShims } = await import("@/lib/shims.js");
		installShims();
		const shim = readFileSync(
			join(tempDir, ".codev-hub", "bin", "opencode"),
			"utf-8",
		);
		expect(shim).toContain('SHIM_DIR="$HOME/.codev-hub/bin"');
		expect(shim).toContain("for p in $PATH; do");
		expect(shim).toContain('if [ "$p" != "$SHIM_DIR" ]; then');
		expect(shim).toContain("export PATH");
		// The PATH munging must happen BEFORE the exec line so the new PATH is
		// what `codevhub` (and anything it spawns) actually sees.
		const exportIdx = shim.indexOf("export PATH");
		const execIdx = shim.indexOf("exec codevhub");
		expect(exportIdx).toBeGreaterThan(-1);
		expect(execIdx).toBeGreaterThan(exportIdx);
	});

	test("shim routes through codevhub when the hub is on PATH", async () => {
		const { installShims, shimDir } = await import("@/lib/shims.js");
		installShims();
		const fakeBin = join(tempDir, "fake-bin");
		mkdirSync(fakeBin, { recursive: true });
		writeFileSync(join(fakeBin, "codevhub"), '#!/bin/sh\necho hub "$@"\n', {
			mode: 0o755,
		});
		writeFileSync(join(fakeBin, "codev"), '#!/bin/sh\necho agent "$@"\n', {
			mode: 0o755,
		});

		const result = spawnSync("/bin/sh", [join(shimDir(), "codev"), "--auto"], {
			encoding: "utf-8",
			env: { HOME: tempDir, PATH: `${shimDir()}:${fakeBin}` },
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("hub codev --auto");
	});

	test("shim falls back to the real agent when codevhub is missing", async () => {
		// The hub can be npm-uninstalled without `codevhub unhook` — the shim
		// must then run the agent itself rather than dying on the missing hub.
		const { installShims, shimDir } = await import("@/lib/shims.js");
		installShims();
		const fakeBin = join(tempDir, "fake-bin");
		mkdirSync(fakeBin, { recursive: true });
		writeFileSync(join(fakeBin, "codev"), '#!/bin/sh\necho agent "$@"\n', {
			mode: 0o755,
		});

		const result = spawnSync("/bin/sh", [join(shimDir(), "codev"), "--auto"], {
			encoding: "utf-8",
			env: { HOME: tempDir, PATH: `${shimDir()}:${fakeBin}` },
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("agent --auto");
	});

	test("rerun does not duplicate aliases inside the sentinel block", async () => {
		const { installShims } = await import("@/lib/shims.js");
		installShims();
		installShims();
		const zshrc = readFileSync(join(tempDir, ".zshrc"), "utf-8");
		expect(zshrc.match(/alias claude=/g)?.length).toBe(1);
	});

	test("scoped install writes only the requested shims", async () => {
		const { installShims } = await import("@/lib/shims.js");
		const result = installShims(["claude"]);

		expect(result.shimsWritten).toEqual(["claude"]);
		expect(existsSync(join(tempDir, ".codev-hub", "bin", "claude"))).toBe(true);
		expect(existsSync(join(tempDir, ".codev-hub", "bin", "codex"))).toBe(false);
		expect(existsSync(join(tempDir, ".codev-hub", "bin", "opencode"))).toBe(
			false,
		);

		const zshrc = readFileSync(join(tempDir, ".zshrc"), "utf-8");
		expect(zshrc).toContain('alias claude="$HOME/.codev-hub/bin/claude"');
		expect(zshrc).not.toContain("alias codex=");
		expect(zshrc).not.toContain("alias opencode=");
	});

	test("second install is additive: keeps existing shims and aliases both", async () => {
		// User first installs Claude Code, then re-runs install picking OpenCode.
		// The opencode shim is added, the claude shim survives, and the rc-file
		// alias block lists both.
		const { installShims } = await import("@/lib/shims.js");
		installShims(["claude"]);
		const result = installShims(["opencode"]);

		expect(result.shimsWritten).toEqual(["opencode"]);
		expect(existsSync(join(tempDir, ".codev-hub", "bin", "claude"))).toBe(true);
		expect(existsSync(join(tempDir, ".codev-hub", "bin", "opencode"))).toBe(
			true,
		);
		expect(existsSync(join(tempDir, ".codev-hub", "bin", "codex"))).toBe(false);

		const zshrc = readFileSync(join(tempDir, ".zshrc"), "utf-8");
		expect(zshrc).toContain('alias claude="$HOME/.codev-hub/bin/claude"');
		expect(zshrc).toContain('alias opencode="$HOME/.codev-hub/bin/opencode"');
		expect(zshrc).not.toContain("alias codex=");
		// One sentinel block, not two — the second install replaces in place.
		expect(zshrc.match(/# >>> codev shims \(managed\) >>>/g)?.length).toBe(1);
	});
});

describe.skipIf(process.platform === "win32")("uninstallShims (Unix)", () => {
	test("removes shim files and the sentinel block from rc files", async () => {
		const { installShims, uninstallShims } = await import("@/lib/shims.js");
		installShims();

		// Sanity: shims and rc blocks are in place.
		expect(existsSync(join(tempDir, ".codev-hub", "bin", "claude"))).toBe(true);
		expect(readFileSync(join(tempDir, ".zshrc"), "utf-8")).toContain(
			"# >>> codev shims (managed) >>>",
		);

		const result = uninstallShims();

		expect(result.shimsRemoved.sort()).toEqual(
			["claude", "codev", "codex", "opencode"]
				.map((a) => join(tempDir, ".codev-hub", "bin", a))
				.sort(),
		);
		for (const agent of ["claude", "codev", "codex", "opencode"]) {
			expect(existsSync(join(tempDir, ".codev-hub", "bin", agent))).toBe(false);
		}
		for (const name of [".zshrc", ".bashrc", ".bash_profile"]) {
			const contents = readFileSync(join(tempDir, name), "utf-8");
			expect(contents).not.toContain("# >>> codev shims (managed) >>>");
			expect(contents).not.toContain("$HOME/.codev-hub/bin");
			expect(result.rcFilesUpdated).toContain(join(tempDir, name));
		}
	});

	test("preserves user content surrounding the sentinel block", async () => {
		const zshrc = join(tempDir, ".zshrc");
		writeFileSync(zshrc, "export FOO=bar\n");
		const { installShims, uninstallShims } = await import("@/lib/shims.js");
		installShims();
		uninstallShims();

		const after = readFileSync(zshrc, "utf-8");
		expect(after).toContain("export FOO=bar");
		expect(after).not.toContain("# >>> codev shims (managed) >>>");
	});

	test("is a no-op on a never-blocked home", async () => {
		const { uninstallShims } = await import("@/lib/shims.js");
		const result = uninstallShims();
		expect(result.shimsRemoved).toEqual([]);
		expect(result.rcFilesUpdated).toEqual([]);
	});

	test("running twice is safe", async () => {
		const { installShims, uninstallShims } = await import("@/lib/shims.js");
		installShims();
		const first = uninstallShims();
		const second = uninstallShims();
		expect(first.shimsRemoved.length).toBeGreaterThan(0);
		expect(second.shimsRemoved).toEqual([]);
		expect(second.rcFilesUpdated).toEqual([]);
	});

	test("leaves ~/.codev-hub/auth.json alone", async () => {
		const codevDir = join(tempDir, ".codev-hub");
		mkdirSync(codevDir, { recursive: true });
		writeFileSync(join(codevDir, "auth.json"), '{"token":"x"}');
		const { installShims, uninstallShims } = await import("@/lib/shims.js");
		installShims();
		uninstallShims();
		expect(existsSync(join(codevDir, "auth.json"))).toBe(true);
		expect(readFileSync(join(codevDir, "auth.json"), "utf-8")).toBe(
			'{"token":"x"}',
		);
	});

	test("removes the now-empty shim dir", async () => {
		const { installShims, uninstallShims } = await import("@/lib/shims.js");
		installShims();
		expect(existsSync(join(tempDir, ".codev-hub", "bin"))).toBe(true);
		uninstallShims();
		expect(existsSync(join(tempDir, ".codev-hub", "bin"))).toBe(false);
	});

	test("leaves the shim dir alone when it contains user files", async () => {
		const { installShims, uninstallShims } = await import("@/lib/shims.js");
		installShims();
		const userFile = join(tempDir, ".codev-hub", "bin", "my-script");
		writeFileSync(userFile, "#!/bin/sh\necho hi\n");
		uninstallShims();
		expect(existsSync(userFile)).toBe(true);
	});

	test("also sweeps the legacy codev-code shim from pre-0.4 installs", async () => {
		const { installShims, uninstallShims } = await import("@/lib/shims.js");
		installShims(["claude"]);
		const legacy = join(tempDir, ".codev-hub", "bin", "codev-code");
		writeFileSync(legacy, '#!/bin/sh\nexec codev codev-code "$@"\n');
		uninstallShims();
		expect(existsSync(legacy)).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("repairShims (Unix)", () => {
	test("is a no-op when no shim dir exists", async () => {
		const { repairShims } = await import("@/lib/shims.js");
		expect(repairShims()).toBe(false);
	});

	test("is a no-op when shims already match the current template", async () => {
		const { installShims, repairShims } = await import("@/lib/shims.js");
		installShims(["claude"]);
		const path = join(tempDir, ".codev-hub", "bin", "claude");
		const before = readFileSync(path, "utf-8");
		expect(repairShims()).toBe(false);
		expect(readFileSync(path, "utf-8")).toBe(before);
	});

	test("rewrites pre-fallback shims that die when the hub is uninstalled", async () => {
		const { repairShims } = await import("@/lib/shims.js");
		const dir = join(tempDir, ".codev-hub", "bin");
		mkdirSync(dir, { recursive: true });
		// A current-generation-minus-one shim: routes through codevhub but has
		// no missing-hub fallback.
		writeFileSync(
			join(dir, "claude"),
			'#!/bin/sh\nexec codevhub claude "$@"\n',
			{ mode: 0o755 },
		);
		expect(repairShims()).toBe(true);
		const body = readFileSync(join(dir, "claude"), "utf-8");
		expect(body).toContain("command -v codevhub");
		expect(body).toContain('exec claude "$@"');
	});

	test("rewrites pre-0.4 shims that exec the old `codev` hub command", async () => {
		const { repairShims } = await import("@/lib/shims.js");
		const dir = join(tempDir, ".codev-hub", "bin");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "claude"), '#!/bin/sh\nexec codev claude "$@"\n', {
			mode: 0o755,
		});
		expect(repairShims()).toBe(true);
		expect(readFileSync(join(dir, "claude"), "utf-8")).toContain(
			'exec codevhub claude "$@"',
		);
	});

	test("migrates the legacy codev-code shim to a codev shim", async () => {
		const { repairShims } = await import("@/lib/shims.js");
		const dir = join(tempDir, ".codev-hub", "bin");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "codev-code"),
			'#!/bin/sh\nexec codev codev-code "$@"\n',
			{ mode: 0o755 },
		);
		expect(repairShims()).toBe(true);
		expect(existsSync(join(dir, "codev-code"))).toBe(false);
		expect(readFileSync(join(dir, "codev"), "utf-8")).toContain(
			'exec codevhub codev "$@"',
		);
		// The rc alias block is refreshed too: new alias in, stale alias out.
		const zshrc = readFileSync(join(tempDir, ".zshrc"), "utf-8");
		expect(zshrc).toContain('alias codev="$HOME/.codev-hub/bin/codev"');
		expect(zshrc).not.toContain("codev-code");
	});
});

// Simulate Windows by patching process.platform on a Unix host. Skipped on
// actual Windows hosts to avoid the simulation conflicting with the real
// platform code path (e.g. updateWindowsUserPath actually shelling out).
describe.skipIf(process.platform === "win32")(
	"installShims (Windows simulation)",
	() => {
		const psProfile = () =>
			join(
				tempDir,
				"Documents",
				"PowerShell",
				"Microsoft.PowerShell_profile.ps1",
			);

		test("scoped install writes only the requested .cmd shim and PS function", async () => {
			const { installShims } = await import("@/lib/shims.js");
			const result = withPlatform("win32", () => installShims(["claude"]));

			expect(result.shimsWritten).toEqual(["claude"]);
			expect(existsSync(join(tempDir, ".codev-hub", "bin", "claude.cmd"))).toBe(
				true,
			);
			expect(existsSync(join(tempDir, ".codev-hub", "bin", "codex.cmd"))).toBe(
				false,
			);
			expect(
				existsSync(join(tempDir, ".codev-hub", "bin", "opencode.cmd")),
			).toBe(false);

			const profile = readFileSync(psProfile(), "utf-8");
			expect(profile).toContain("# >>> codev shims (managed) >>>");
			expect(profile).toContain(
				'if (Test-Path "$HOME\\.codev-hub\\bin\\claude.cmd") { function claude { & "$HOME\\.codev-hub\\bin\\claude.cmd" @args } }',
			);
			expect(profile).not.toContain("function codex");
			expect(profile).not.toContain("function opencode");
		});

		test("second install is additive: keeps existing .cmd shims and lists both functions", async () => {
			const { installShims } = await import("@/lib/shims.js");
			withPlatform("win32", () => installShims(["claude"]));
			const result = withPlatform("win32", () => installShims(["opencode"]));

			expect(result.shimsWritten).toEqual(["opencode"]);
			expect(existsSync(join(tempDir, ".codev-hub", "bin", "claude.cmd"))).toBe(
				true,
			);
			expect(
				existsSync(join(tempDir, ".codev-hub", "bin", "opencode.cmd")),
			).toBe(true);
			expect(existsSync(join(tempDir, ".codev-hub", "bin", "codex.cmd"))).toBe(
				false,
			);

			const profile = readFileSync(psProfile(), "utf-8");
			expect(profile).toContain(
				'function claude { & "$HOME\\.codev-hub\\bin\\claude.cmd" @args }',
			);
			expect(profile).toContain(
				'function opencode { & "$HOME\\.codev-hub\\bin\\opencode.cmd" @args }',
			);
			expect(profile).not.toContain("function codex");
			// One sentinel block after the second install — replaced in place.
			expect(profile.match(/# >>> codev shims \(managed\) >>>/g)?.length).toBe(
				1,
			);
		});
	},
);
