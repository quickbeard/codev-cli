import {
	accessSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { loadApiKey } from "@/lib/auth.js";
import {
	fetchAnalysisBackendSession,
	fetchApiKey,
	fetchCodevConfig,
	fetchModels,
	smokeTestModel,
	validateApiKey,
} from "@/lib/backend.js";
import {
	detectConfiguredTools,
	getBackupStatus,
	type Tool,
} from "@/lib/configure.js";
import {
	BACKEND_URL,
	FALLBACK_MODEL,
	MIN_NODE_STRING,
	NODE_DOWNLOAD_URL,
	nodeVersionMeets,
	parseNodeVersion,
	RECOMMENDED_NODE,
	VERSION,
} from "@/lib/const.js";
import {
	currentTraceId,
	logDebug,
	logError,
	loggedFetch,
	logInfo,
	logWarn,
	type RequestRecord,
	recordRequests,
	redactSecrets,
	requestLog,
} from "@/lib/log.js";
import {
	CLI,
	type CommandRecord,
	commandLog,
	execAsync,
	type NpmTool,
	npmGlobalRoot,
	PKG,
	recordCommands,
} from "@/lib/npm.js";
import { doctorReportPath } from "@/lib/paths.js";
import {
	backendHost,
	envVarKeys,
	hasProxyConfigured,
	maskProxyCredentials,
	matchingNoProxyEntry,
	overrideEnvVar,
	type ProxyEnv,
	type ProxyEnvVar,
	proxyAutoEnabled,
	proxyEnvSummary,
	proxyForUrl,
	readProxyEnv,
	stripNoProxyFor,
} from "@/lib/proxy.js";
import { spawner } from "@/lib/reexec.js";
import { agentOnPath, resolveAgentPath } from "@/lib/run.js";
import { detectInstalledShims } from "@/lib/shims.js";
import { isCertError, tlsApi } from "@/lib/tls.js";
import {
	describeStdin,
	rawModeSupported,
	stdinApi,
	stdinKind,
	terminalCause,
	terminalEvidence,
	terminalFix,
} from "@/lib/tty.js";

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

// The Node floor and its rationale live in lib/const.ts so index.tsx can gate
// on them without importing this module's dependency graph.

// The internal registry mirror from the install guide. Suggested, never set.
export const INTERNAL_NPM_REGISTRY =
	"http://10.60.129.132/repository/npm-proxy";
const PUBLIC_NPM_REGISTRY = /registry\.npmjs\.org/;

// The package `codevhub` itself ships as — probed against the registry to prove
// an authenticated read works end-to-end through the proxy.
const SELF_PKG = "codev-ai";

// Deliberately more generous than backend.ts's 5s/10s/15s, which are tuned for
// the interactive install flow. Behind a slow proxy those produce spurious
// timeouts, and a pre-flight check that cries wolf is worse than none.
const REACH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Check model
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type CheckGroup =
	| "environment"
	| "network"
	| "account"
	| "llm"
	| "state";

export interface CheckResult {
	status: CheckStatus;
	/** One-line outcome. Always shown, whatever the status. */
	detail: string;
	/** Remediation. Collected into the final "Next steps" block. */
	fix?: string;
	/** Full diagnosis, rendered inline under a failing row. */
	diagnosis?: Diagnosis;
}

export interface DoctorContext {
	/** SSO access token, set once the login check passes. */
	accessToken?: string;
	/** Gateway API key, set by the api-key check. */
	apiKey?: string;
	/** Gateway base URL, set by the codev-config check. */
	gatewayUrl?: string;
	/** Model ids, set by the models check. */
	models?: string[];
	/** Analysis backend URL, set by the codev-config check. */
	analysisBackendUrl?: string;
}

export interface Check {
	key: string;
	label: string;
	group: CheckGroup;
	run: (ctx: DoctorContext) => Promise<CheckResult>;
}

/**
 * One thing a check actually did — a subprocess it spawned or a request it
 * made — shown under that check's row.
 *
 * Deliberately carries no pass/fail marker of its own. An earlier revision
 * listed requests separately with their own icons, and scoring a 401 as a
 * failure contradicted the check above it that (correctly) called the same 401
 * a pass. The check's icon is the verdict; these lines are evidence.
 */
export interface CheckActivity {
	kind: "command" | "request";
	detail: string;
	durationMs: number;
}

export interface CheckOutcome extends CheckResult {
	key: string;
	label: string;
	group: CheckGroup;
	/** What this check ran, in order. */
	activity?: CheckActivity[];
}

// ---------------------------------------------------------------------------
// Error diagnosis
//
// This is the reason the command exists. `describeNetworkError` (lib/tls.ts)
// unwraps ONE level of err.cause and only special-cases certificate codes;
// everything else still reaches the user as `fetch failed` or
// `fetch failed (connect ECONNREFUSED 10.0.0.1:8080)`, which tells a
// non-engineer nothing. Here we walk the whole chain, name the failure in plain
// language, say what most likely caused it *on this machine*, give the fix, and
// print the raw chain so nothing is hidden from support.
// ---------------------------------------------------------------------------

export interface Diagnosis {
	/** Plain language, not the errno. */
	what: string;
	/** Most likely cause, specific to this environment. */
	cause: string;
	/** The concrete fix. */
	fix: string;
	/** Connection state that determined the outcome. */
	context: string[];
	/** The verbatim error chain, one line per link. */
	raw: string[];
}

/** What we were doing when it broke. Drives the context block. */
export interface Attempt {
	url?: string;
	method?: string;
	timeoutMs?: number;
	/** For child processes: the exact command line. */
	command?: string;
}

interface ErrorLink {
	name: string;
	message: string;
	code?: string;
	errno?: number;
	syscall?: string;
	hostname?: string;
	address?: string;
	port?: number;
}

// Node's fetch throws `TypeError: fetch failed` and hides the real reason on
// .cause — sometimes several levels down, sometimes inside an AggregateError
// (one entry per address family when a host resolves to both A and AAAA).
// Flatten the whole thing; the first link carrying a `code` is the real failure.
function errorChain(err: unknown, depth = 0): ErrorLink[] {
	if (depth > 8 || !(err instanceof Error)) return [];
	const e = err as NodeJS.ErrnoException & { errors?: unknown[] };
	const link: ErrorLink = {
		name: err.name,
		message: err.message,
		code: typeof e.code === "string" ? e.code : undefined,
		errno: typeof e.errno === "number" ? e.errno : undefined,
		syscall: typeof e.syscall === "string" ? e.syscall : undefined,
		hostname: (e as { hostname?: string }).hostname,
		address: (e as { address?: string }).address,
		port: (e as { port?: number }).port,
	};
	const nested: ErrorLink[] = [];
	if (Array.isArray(e.errors)) {
		for (const inner of e.errors) nested.push(...errorChain(inner, depth + 1));
	}
	if (err.cause !== undefined) nested.push(...errorChain(err.cause, depth + 1));
	return [link, ...nested];
}

// Codes we know how to explain. Used both to pick the root link and to recover
// a code that only survives in the message text.
const KNOWN_CODES = [
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"ECONNRESET",
	"EPROTO",
	"UND_ERR_SOCKET",
	"CERT_HAS_EXPIRED",
	"ERR_TLS_CERT_ALTNAME_INVALID",
];

// Node normally sets `.code` on the underlying error, but code that catches and
// re-throws routinely loses it while keeping the text ("getaddrinfo ENOTFOUND
// host", "connect ECONNREFUSED 10.0.0.1:8080"). Recovering it from the message
// is the difference between a real diagnosis and the generic fallback.
function inferCodeFromMessage(message: string): string | undefined {
	return KNOWN_CODES.find((code) => message.includes(code));
}

// A bare `Error("getaddrinfo ENOTFOUND api.example.com")` still names the host;
// pull it out so the explanation can say which host failed.
function inferHostFromMessage(message: string): string | undefined {
	const dns = /(?:getaddrinfo|queryA\w*)\s+\w+\s+([\w.-]+)/.exec(message);
	if (dns?.[1]) return dns[1];
	const conn = /connect\s+\w+\s+([\d.a-f:]+):(\d+)/i.exec(message);
	if (conn?.[1]) return conn[1];
	return undefined;
}

/**
 * The first link that carries an OS/undici error code — the real failure.
 *
 * Falls back to recovering the code (and host/port) from the message text, so
 * a re-thrown error that lost its properties still gets a real diagnosis
 * instead of the generic one.
 */
function rootLink(chain: ErrorLink[]): ErrorLink | undefined {
	const withCode = chain.find((l) => l.code !== undefined);
	if (withCode) return withCode;

	for (const link of chain) {
		const code = inferCodeFromMessage(link.message);
		if (!code) continue;
		const conn = /connect\s+\w+\s+([\d.a-f:]+):(\d+)/i.exec(link.message);
		return {
			...link,
			code,
			hostname: link.hostname ?? inferHostFromMessage(link.message),
			address: link.address ?? conn?.[1],
			port: link.port ?? (conn?.[2] ? Number(conn[2]) : undefined),
		};
	}
	return chain[chain.length - 1];
}

function renderChain(chain: ErrorLink[]): string[] {
	return chain.map((link, i) => {
		const indent = i === 0 ? "" : `${"  ".repeat(i - 1)}└ `;
		const facts = [
			link.code && `code ${link.code}`,
			link.syscall && `syscall ${link.syscall}`,
			link.hostname && `hostname ${link.hostname}`,
			link.address && `address ${link.address}`,
			link.port !== undefined && `port ${link.port}`,
		].filter(Boolean);
		const suffix = facts.length > 0 ? `  (${facts.join(" · ")})` : "";
		return redactSecrets(`${indent}${link.name}: ${link.message}${suffix}`);
	});
}

/** Where a proxy applies from, for the context block. */
function proxyDescription(proxy: ProxyEnv): string {
	if (!hasProxyConfigured(proxy)) return "proxy: none";
	const parts: string[] = [];
	if (proxy.httpsProxy) {
		parts.push(`HTTPS_PROXY=${maskProxyCredentials(proxy.httpsProxy)}`);
	}
	if (proxy.httpProxy) {
		parts.push(`HTTP_PROXY=${maskProxyCredentials(proxy.httpProxy)}`);
	}
	return `proxy: ${parts.join(" · ")}`;
}

// The single most common silent failure: a proxy is set, but Node was never
// told to use it, so every request goes direct and dies in the firewall. Node
// gives no hint whatsoever that it ignored the variable.
function proxyIgnoredNote(proxy: ProxyEnv): string | null {
	if (!hasProxyConfigured(proxy)) return null;
	if (proxy.useEnvProxy) return null;
	return "NODE_USE_ENV_PROXY is unset — Node is IGNORING your proxy settings";
}

function connectionContext(attempt: Attempt): string[] {
	const proxy = readProxyEnv();
	const lines: string[] = [];
	if (attempt.command) lines.push(`command: ${attempt.command}`);
	if (attempt.url) {
		const timeout = attempt.timeoutMs
			? ` (timeout ${Math.round(attempt.timeoutMs / 1000)}s)`
			: "";
		lines.push(
			redactSecrets(`${attempt.method ?? "GET"} ${attempt.url}${timeout}`),
		);
	}
	const ignored = proxyIgnoredNote(proxy);
	lines.push(
		`${proxyDescription(proxy)} · NODE_USE_ENV_PROXY: ${
			proxy.useEnvProxy ? "on" : "unset"
		}`,
	);
	if (ignored) lines.push(`⚠ ${ignored}`);

	const noProxyEntry = matchingNoProxyEntry(proxy, backendHost());
	lines.push(
		`NO_PROXY: ${proxy.noProxy ?? "unset"}${
			noProxyEntry ? ` — "${noProxyEntry}" exempts ${backendHost()}` : ""
		}`,
	);
	lines.push(`node ${process.version} · ${process.platform} ${process.arch}`);
	return lines;
}

// A proxy is configured but Node was told to ignore it — that supersedes every
// other explanation, because nothing else can be diagnosed until it's fixed.
function proxyMisconfigFix(proxy: ProxyEnv): string | null {
	if (!hasProxyConfigured(proxy) || proxy.useEnvProxy) return null;
	return (
		"Set NODE_USE_ENV_PROXY=1 alongside HTTP_PROXY/HTTPS_PROXY. Node ignores " +
		"proxy environment variables without it, and reads it only at startup."
	);
}

const NO_PROXY_SET_FIX =
	"No proxy is configured. If this network requires one, set HTTP_PROXY, " +
	"HTTPS_PROXY and NODE_USE_ENV_PROXY=1, then re-run.";

/**
 * Turn any thrown error into a four-part, human-readable diagnosis.
 *
 * Never returns a bare "fetch failed": every branch produces a plain-language
 * `what`, a `cause` specific to this machine's proxy/TLS state, a concrete
 * `fix`, and the raw chain for support.
 */
export function diagnoseError(err: unknown, attempt: Attempt = {}): Diagnosis {
	const chain = errorChain(err);
	const root = rootLink(chain);
	const proxy = readProxyEnv();
	const context = connectionContext(attempt);
	const raw =
		chain.length > 0 ? renderChain(chain) : [redactSecrets(String(err))];
	const host = root?.hostname ?? hostOf(attempt.url) ?? "the server";
	const proxied = hasProxyConfigured(proxy);
	const misconfig = proxyMisconfigFix(proxy);

	const base = (what: string, cause: string, fix: string): Diagnosis => ({
		what,
		// A configured-but-ignored proxy explains every network symptom below,
		// so it wins the "likely cause" slot when present.
		cause: misconfig ? `${cause} ${proxyIgnoredNote(proxy)}.` : cause,
		fix: misconfig ?? fix,
		context,
		raw,
	});

	// AbortSignal.timeout produces a DOMException whose message ("The operation
	// was aborted due to a timeout") names neither the host nor the duration —
	// useless on its own, so rebuild it from the attempt.
	if (root?.name === "TimeoutError" || root?.code === "ABORT_ERR") {
		const secs = attempt.timeoutMs
			? `${Math.round(attempt.timeoutMs / 1000)}s`
			: "the timeout";
		return base(
			`No response from ${host} within ${secs}.`,
			proxied
				? "The proxy accepted the connection but never returned a response — it may be slow, overloaded, or blocking this host."
				: "Traffic to this host is most likely being dropped by a firewall that expects it to go through a proxy.",
			proxied
				? "Confirm the proxy address is correct and that it is allowed to reach this host, then re-run."
				: NO_PROXY_SET_FIX,
		);
	}

	switch (root?.code) {
		case "ENOTFOUND":
		case "EAI_AGAIN":
			return base(
				`Could not resolve ${host} (DNS lookup failed).`,
				proxied
					? "A proxy is configured, so DNS should be resolved by the proxy — the request appears to have gone direct instead."
					: "No proxy is configured and this network's DNS does not resolve external names.",
				proxied
					? "Check that the proxy URL is well-formed (http://host:port) and that this host is not listed in NO_PROXY."
					: NO_PROXY_SET_FIX,
			);

		case "ECONNREFUSED":
			return base(
				`Connection refused by ${root.address ?? host}${
					root.port !== undefined ? `:${root.port}` : ""
				}.`,
				// Only call it "your proxy" when the error actually named the
				// address it tried. Without one we fall back to the request host,
				// and asserting that the *destination* is the proxy contradicts the
				// line right above it.
				proxied && root.address
					? "That address is your proxy — nothing is listening on it, so the proxy host or port is wrong."
					: proxied
						? "A proxy is configured, so the refusal most likely came from the proxy rather than the destination."
						: "Nothing accepted a connection on that address.",
				proxied
					? "Double-check HTTP_PROXY / HTTPS_PROXY. The value must include the scheme and port, e.g. http://10.0.0.1:8080."
					: NO_PROXY_SET_FIX,
			);

		case "ETIMEDOUT":
		case "UND_ERR_CONNECT_TIMEOUT":
			return base(
				`Timed out connecting to ${root.address ?? host}.`,
				proxied
					? "The proxy address is reachable in principle but never completed the handshake."
					: "A firewall is silently dropping this traffic, which usually means it must go through a proxy.",
				proxied
					? "Verify the proxy host and port with your IT team, then re-run."
					: NO_PROXY_SET_FIX,
			);

		case "ECONNRESET":
		case "EPROTO":
		case "UND_ERR_SOCKET":
			return base(
				`The connection to ${host} was reset mid-handshake.`,
				"Typically a TLS-intercepting proxy or HTTPS-scanning antivirus rejecting the request.",
				misconfig ??
					"Ask IT for your organization's root CA (a PEM file) and set NODE_EXTRA_CA_CERTS to its path, plus NODE_USE_SYSTEM_CA=1, then re-run.",
			);

		case "CERT_HAS_EXPIRED":
			return base(
				`${host} presented an expired TLS certificate.`,
				"Either the server's certificate genuinely expired, or an intercepting proxy is re-signing with an expired root.",
				"Check your system clock is correct. If it is, ask IT — their interception certificate has expired.",
			);

		case "ERR_TLS_CERT_ALTNAME_INVALID":
			return base(
				`The TLS certificate presented for ${host} is issued for a different hostname.`,
				"A proxy is substituting its own certificate without matching the requested host.",
				"Ask IT to confirm this host is correctly configured for TLS interception, then re-run.",
			);

		default:
			break;
	}

	// Certificate trust failures — reuse tls.ts's classification so both paths
	// agree on what counts as "untrusted chain".
	if (isCertError(err) || root?.code?.includes("CERT")) {
		return base(
			`Node does not trust the TLS certificate presented for ${host}.`,
			"A TLS-intercepting proxy or antivirus is re-signing traffic with a corporate root CA that Node's bundled certificate list does not include.",
			`Set NODE_USE_SYSTEM_CA=1 so Node reads your OS trust store. If the root is not in the OS store either, ask IT for the root CA (PEM) and point NODE_EXTRA_CA_CERTS at it.${
				tlsApi.supported()
					? ""
					: ` Note: Node ${process.version} cannot read the OS store at all — upgrade to Node ${RECOMMENDED_NODE}.`
			}`,
		);
	}

	// Nothing in the chain names a network failure and there is no `cause`, so
	// this is our own code reporting what the server said — a thrown
	// `Backend /auth/exchange failed (401): …`, not a connectivity problem.
	// Running it through the proxy reasoning below would tell a user whose
	// network is fine that they are missing a proxy, which is worse than
	// saying nothing. `base()` is deliberately not used here: its whole job is
	// to fold in proxy speculation.
	if (root?.code === undefined && !isTransportError(err)) {
		const message = root?.message ?? String(err);
		const status = /\((\d{3})\)/.exec(message)?.[1];
		const isAuth = status === "401" || status === "403";
		return {
			what: redactSecrets(message),
			cause: isAuth
				? `${host} answered and rejected the credentials — an authorization result, not a connectivity problem.`
				: `${host} answered; it rejected the request rather than the network failing.`,
			fix: isAuth
				? "Run `codevhub login --force` to re-authenticate, then re-run."
				: "See the raw output below — the server's own message is the best guide here.",
			context,
			raw,
		};
	}

	// Unknown code — still never a bare "fetch failed". Name the deepest message
	// we found and hand over the raw chain.
	return base(
		root?.message
			? `Request to ${host} failed: ${redactSecrets(root.message)}`
			: `Request to ${host} failed.`,
		proxied
			? "A proxy is configured; the failure happened somewhere between this machine, the proxy, and the destination."
			: "No proxy is configured. If this network requires one, that is the most likely cause.",
		misconfig ?? NO_PROXY_SET_FIX,
	);
}

function hostOf(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

// Headers that betray an interceptor sitting between us and the destination.
const INTERCEPTOR_HEADERS = [
	"via",
	"server",
	"proxy-authenticate",
	"www-authenticate",
	"x-cache",
	"cf-ray",
	"x-squid-error",
];

/**
 * Diagnose a non-2xx HTTP response.
 *
 * A response is not an exception, so `describeNetworkError` never sees these at
 * all — yet a 407 or a proxy-issued 403 is exactly what internal users hit.
 */
export function diagnoseResponse(
	status: number,
	statusText: string,
	headers: Headers,
	body: string,
	attempt: Attempt = {},
): Diagnosis {
	const context = connectionContext(attempt);
	const signature = INTERCEPTOR_HEADERS.map((h) => {
		const v = headers.get(h);
		return v ? `${h}: ${v}` : null;
	}).filter((v): v is string => v !== null);
	const snippet = redactSecrets(body.trim()).slice(0, 400);
	const raw = [
		`HTTP ${status} ${statusText}`,
		...signature.map(redactSecrets),
		...(snippet ? [snippet + (body.trim().length > 400 ? "…" : "")] : []),
	];
	const host = hostOf(attempt.url) ?? "the server";

	if (status === 407) {
		return {
			what: "The proxy requires authentication (HTTP 407).",
			cause: `Your proxy is challenging this request: ${
				headers.get("proxy-authenticate") ?? "no scheme advertised"
			}.`,
			fix: "Include your credentials in the proxy URL, e.g. HTTPS_PROXY=http://user:password@host:port, then re-run.",
			context,
			raw,
		};
	}

	if (status === 403) {
		const intercepted =
			signature.length > 0 || /proxy|blocked|denied|firewall/i.test(body);
		return {
			what: `${host} returned HTTP 403 (forbidden).`,
			cause: intercepted
				? "The response carries proxy/gateway signatures, so this looks like the network blocking the request rather than a CoDev permissions problem."
				: "Either your account lacks access, or a proxy is blocking the request without identifying itself.",
			fix: "If you are behind a proxy, this is the documented npm/registry 403: unset HTTP_PROXY and HTTPS_PROXY in the CURRENT shell (do not open a new terminal) and retry.",
			context,
			raw,
		};
	}

	if (status === 502 || status === 503 || status === 504) {
		return {
			what: `${host} returned HTTP ${status} (${statusText || "upstream error"}).`,
			cause:
				"Usually the proxy failing to reach the destination, rather than the destination itself being down.",
			fix: "Retry shortly. If it persists, confirm with IT that the proxy is allowed to reach this host.",
			context,
			raw,
		};
	}

	if (status === 401) {
		return {
			what: `${host} rejected the credentials (HTTP 401).`,
			cause: "The token or API key sent with this request was not accepted.",
			fix: "Run `codevhub login --force` to re-authenticate, then re-run.",
			context,
			raw,
		};
	}

	return {
		what: `${host} returned HTTP ${status}${statusText ? ` (${statusText})` : ""}.`,
		cause:
			signature.length > 0
				? "The response carries proxy signatures, so a network appliance may have rewritten it."
				: "The server rejected the request.",
		fix: "See the raw response below; if it does not look like it came from CoDev, a proxy is intercepting the request.",
		context,
		raw,
	};
}

/** Diagnose a failed child process (npm, agent CLIs). */
export function diagnoseExec(
	command: string,
	exitCode: string | number | null,
	stderr: string,
	isEnoent: boolean,
): Diagnosis {
	// npm's own error text names the registry, proxy and .npmrc in play, so it
	// is reproduced in FULL — truncating it destroys the diagnosis.
	const raw = redactSecrets(stderr.trim() || "(no stderr)")
		.split("\n")
		.map((l) => l.trimEnd());

	if (isEnoent) {
		return {
			what: `\`${command.split(" ")[0]}\` was not found on your PATH.`,
			cause:
				"The program is not installed, or its install directory is not on PATH.",
			fix: "Install Node.js from nodejs.org (npm ships with it) and open a new terminal so PATH is refreshed.",
			context: connectionContext({ command }),
			raw,
		};
	}

	const proxy = readProxyEnv();
	const lower = stderr.toLowerCase();
	let cause =
		"The command ran but exited with an error. The full output is below.";
	let fix = "Read the output below — npm names the registry and proxy it used.";

	if (lower.includes("e403") || lower.includes("403 forbidden")) {
		cause =
			"A 403 from the registry. Behind a corporate proxy this is usually the proxy rejecting the request, not a package permissions problem.";
		fix =
			"Unset the proxy in the CURRENT shell and retry without opening a new terminal: `unset HTTPS_PROXY HTTP_PROXY` (Linux/macOS) or `$env:HTTPS_PROXY = $null; $env:HTTP_PROXY = $null` (PowerShell).";
	} else if (lower.includes("eacces") || lower.includes("permission denied")) {
		cause = "npm could not write to its global install directory.";
		fix =
			"Point npm at a writable prefix (`npm config set prefix ~/.npm-global`) and add its `bin` directory to PATH, or reinstall Node with a user-owned prefix. Avoid `sudo npm i -g`.";
	} else if (
		lower.includes("self-signed") ||
		lower.includes("self signed") ||
		lower.includes("unable_to_get_issuer") ||
		lower.includes("cert")
	) {
		cause =
			"npm could not verify the registry's TLS certificate — a TLS-intercepting proxy is re-signing the connection.";
		fix =
			"Point npm at your organization's root CA: `npm config set cafile <path-to-root-ca.pem>`. npm keeps its own TLS config, separate from Node's.";
	} else if (
		lower.includes("etimedout") ||
		lower.includes("econnrefused") ||
		lower.includes("enotfound") ||
		lower.includes("network")
	) {
		cause = hasProxyConfigured(proxy)
			? "npm could not reach the registry. npm has its OWN proxy configuration, separate from Node's environment variables."
			: "npm could not reach the registry and no proxy is configured.";
		fix = `Set npm's proxy explicitly: \`npm config set proxy <url>\` and \`npm config set https-proxy <url>\`. On the internal network also set the registry mirror: \`npm config set registry ${INTERNAL_NPM_REGISTRY}\`.`;
	}

	return {
		what: `\`${command}\` failed (exit code ${exitCode ?? "unknown"}).`,
		cause,
		fix,
		context: connectionContext({ command }),
		raw,
	};
}

/**
 * Compact single-string rendering, for callers with one line of screen space
 * (Login / FetchApiKey's error frames). Keeps the plain-language explanation
 * and the fix — the two things `fetch failed` never gave anyone.
 */
export function renderDiagnosisCompact(d: Diagnosis): string {
	const lines = [d.what, d.cause, `Fix: ${d.fix}`];
	return lines.join("\n");
}

/**
 * True when an error came from the transport layer (DNS/TCP/TLS) rather than
 * from an HTTP response our own code turned into an Error.
 *
 * Node's fetch always nests the real reason on `.cause`; a
 * `new Error("Backend /config failed (403): forbidden")` thrown by backend.ts
 * has none. The distinction matters: the proxy-oriented reasoning in
 * `diagnoseError` is exactly right for the former and actively misleading for
 * the latter, whose own message is already precise.
 */
export function isTransportError(err: unknown): boolean {
	return err instanceof Error && err.cause !== undefined;
}

/**
 * Compact, always-useful failure text for callers with a single error frame:
 * a full diagnosis for transport failures, the server's own message otherwise.
 */
export function describeFailure(err: unknown, attempt: Attempt = {}): string {
	if (isTransportError(err)) {
		return renderDiagnosisCompact(diagnoseError(err, attempt));
	}
	return err instanceof Error ? redactSecrets(err.message) : String(err);
}

// ---------------------------------------------------------------------------
// Probing helpers
// ---------------------------------------------------------------------------

/** Run a thunk, converting any throw into a `fail` with a full diagnosis. */
async function guard(
	attempt: Attempt,
	fn: () => Promise<CheckResult>,
): Promise<CheckResult> {
	try {
		return await fn();
	} catch (err) {
		const diagnosis = diagnoseError(err, attempt);
		return {
			status: "fail",
			detail: diagnosis.what,
			fix: diagnosis.fix,
			diagnosis,
		};
	}
}

/**
 * Transport-only reachability probe. ANY HTTP response — including 3xx and
 * 401/403/404 — proves the network path works, which is all this is asking.
 * Only DNS/TCP/TLS failures fail it.
 *
 * `redirect: "manual"` is load-bearing, not tidiness. `fetch` follows redirects
 * by default, and the gateway 301s bare directory-ish paths to its *internal*
 * origin (`GET /codev-backend` → `http://netmind.viettel.vn:9096/codev-backend/`,
 * note the port and the downgrade to http). Following that from outside the
 * corporate network times out, so the probe reported the backend unreachable
 * on machines where every real API call worked. A redirect response is already
 * proof the transport works; chasing it measures a different host and port.
 */
async function reach(
	url: string,
	label: string,
	method = "GET",
): Promise<CheckResult> {
	const attempt = { url, method, timeoutMs: REACH_TIMEOUT_MS };
	return guard(attempt, async () => {
		const res = await loggedFetch("doctor.reach", url, {
			method,
			redirect: "manual",
			signal: AbortSignal.timeout(REACH_TIMEOUT_MS),
		});
		// 407 is the one status that means the transport is NOT usable.
		if (res.status === 407) {
			const diagnosis = diagnoseResponse(
				res.status,
				res.statusText,
				res.headers,
				await res.text().catch(() => ""),
				attempt,
			);
			return {
				status: "fail",
				detail: diagnosis.what,
				fix: diagnosis.fix,
				diagnosis,
			};
		}
		// An unauthenticated probe is *supposed* to be rejected; saying so keeps
		// a 401 from reading like a failure in a report full of real ones.
		const note =
			res.status === 401 || res.status === 403
				? " — expected without credentials"
				: "";
		return {
			status: "pass",
			detail: `${label} reachable (HTTP ${res.status}${note}).`,
		};
	});
}

/** `npm config get <key>`, or null when npm can't answer. */
async function npmConfig(key: string): Promise<string | null> {
	const r = await execAsync("npm", ["config", "get", key]);
	if (r.error) return null;
	const value = r.stdout.trim();
	// npm prints the literal string "undefined"/"null" for unset keys.
	if (!value || value === "undefined" || value === "null") return null;
	return value;
}

// ---------------------------------------------------------------------------
// Group 1 — environment (synchronous, no network)
// ---------------------------------------------------------------------------

const nodeVersionCheck: Check = {
	key: "node-version",
	label: "Node.js version",
	group: "environment",
	run: async () => {
		const version = process.versions.node;
		if (!nodeVersionMeets(version)) {
			return {
				status: "fail",
				detail: `Node ${version} is too old — CoDev requires >= ${MIN_NODE_STRING}.`,
				fix: `Install Node ${RECOMMENDED_NODE} from ${NODE_DOWNLOAD_URL} and re-run.`,
				diagnosis: {
					what: `Node ${version} is below the required ${MIN_NODE_STRING}.`,
					cause:
						"Support for HTTP_PROXY/HTTPS_PROXY was added to the Node 22 line in 22.21.0. Below that, Node silently ignores proxy environment variables, so sign-in can never work behind a corporate proxy no matter how you configure it.",
					fix: `Install Node ${RECOMMENDED_NODE} from ${NODE_DOWNLOAD_URL}, open a new terminal, and re-run \`codevhub doctor\`.`,
					context: [
						`node ${process.version} · ${process.platform} ${process.arch}`,
						`required >= ${MIN_NODE_STRING} · recommended ${RECOMMENDED_NODE}`,
					],
					raw: [`process.versions.node = ${version}`],
				},
			};
		}
		const [major] = parseNodeVersion(version);
		if (major < 24) {
			return {
				status: "pass",
				detail: `Node ${version} meets the minimum (Node ${RECOMMENDED_NODE} recommended).`,
			};
		}
		return { status: "pass", detail: `Node ${version}.` };
	},
};

const npmAvailableCheck: Check = {
	key: "npm-available",
	label: "npm available",
	group: "environment",
	run: async () => {
		const r = await execAsync("npm", ["-v"]);
		if (r.error) {
			const diagnosis = diagnoseExec(
				"npm -v",
				r.error.code ?? null,
				r.stderr,
				r.error.code === "ENOENT",
			);
			return {
				status: "fail",
				detail: diagnosis.what,
				fix: diagnosis.fix,
				diagnosis,
			};
		}
		return { status: "pass", detail: `npm ${r.stdout.trim()}.` };
	},
};

// The two most common global-install failures, both documented: the prefix bin
// directory missing from PATH (Windows "PowerShell can't find the package") and
// EACCES writing into it.
const npmPrefixCheck: Check = {
	key: "npm-prefix",
	label: "npm global prefix",
	group: "environment",
	run: async () => {
		const prefix = await npmConfig("prefix");
		if (!prefix) {
			return {
				status: "warn",
				detail: "Could not read `npm config get prefix`.",
				fix: "Confirm npm is installed and working (`npm -v`).",
			};
		}
		// npm puts global bins in <prefix>/bin on Unix and directly in <prefix>
		// on Windows.
		const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");
		const onPath = (process.env.PATH ?? "")
			.split(delimiter)
			.some((dir) => dir && normalizePath(dir) === normalizePath(binDir));

		let writable = true;
		try {
			accessSync(existsSync(binDir) ? binDir : prefix, fsConstants.W_OK);
		} catch {
			writable = false;
		}

		if (!writable) {
			return {
				status: "fail",
				detail: `npm's global directory is not writable: ${binDir}`,
				fix: "Point npm at a writable prefix (`npm config set prefix ~/.npm-global`) and add its bin directory to PATH. Avoid `sudo npm i -g`, which creates root-owned files.",
				diagnosis: {
					what: `\`npm i -g\` cannot write to ${binDir}.`,
					cause:
						"The global prefix is owned by another user (commonly root, after an earlier `sudo npm i -g`), so installing agents will fail with EACCES.",
					fix: "Run `npm config set prefix ~/.npm-global`, add `~/.npm-global/bin` to PATH, open a new terminal, and re-run.",
					context: [`prefix: ${prefix}`, `bin: ${binDir}`],
					raw: [`accessSync(${binDir}, W_OK) threw`],
				},
			};
		}

		if (!onPath) {
			return {
				status: "warn",
				detail: `npm's global bin directory is not on PATH: ${binDir}`,
				fix:
					process.platform === "win32"
						? 'Add it in PowerShell: $npmPath = npm config get prefix; [Environment]::SetEnvironmentVariable("PATH", "$([Environment]::GetEnvironmentVariable(\'PATH\',\'User\'));$npmPath", "User") — then open a new terminal.'
						: `Add it to your shell profile: export PATH="${binDir}:$PATH" — then open a new terminal.`,
			};
		}

		return { status: "pass", detail: `${binDir} (on PATH, writable).` };
	},
};

function normalizePath(p: string): string {
	const trimmed = p.replace(/[\\/]+$/, "");
	return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

const npmRegistryCheck: Check = {
	key: "npm-registry",
	label: "npm registry configuration",
	group: "environment",
	run: async () => {
		const [registry, proxy, httpsProxy, strictSsl, cafile] = await Promise.all([
			npmConfig("registry"),
			npmConfig("proxy"),
			npmConfig("https-proxy"),
			npmConfig("strict-ssl"),
			npmConfig("cafile"),
		]);
		const parts = [`registry: ${registry ?? "unset"}`];
		if (proxy) parts.push(`proxy: ${proxy}`);
		if (httpsProxy) parts.push(`https-proxy: ${httpsProxy}`);
		if (cafile) parts.push(`cafile: ${cafile}`);
		if (strictSsl === "false") parts.push("strict-ssl: false");
		const detail = parts.join(" · ");

		// npm keeps its own proxy/TLS configuration entirely separate from Node's
		// environment variables — a working `codevhub` says nothing about whether
		// `npm i -g` will work.
		const env = readProxyEnv();
		if (hasProxyConfigured(env) && !proxy && !httpsProxy) {
			return {
				status: "warn",
				detail,
				fix: `Your shell has a proxy but npm does not — npm keeps its own config. Run: npm config set proxy ${env.httpsProxy ?? env.httpProxy} && npm config set https-proxy ${env.httpsProxy ?? env.httpProxy}`,
			};
		}
		if (registry && PUBLIC_NPM_REGISTRY.test(registry)) {
			return {
				status: "warn",
				detail,
				fix: `On the internal network the public registry is usually unreachable. Set the mirror: npm config set registry ${INTERNAL_NPM_REGISTRY}`,
			};
		}
		return { status: "pass", detail };
	},
};

const proxyEnvCheck: Check = {
	key: "proxy-env",
	label: "Proxy & TLS environment",
	group: "environment",
	run: async () => {
		const env = readProxyEnv();
		const host = backendHost();
		// The core variables are always listed, set or not: most of the failures
		// this command exists for are a *missing* variable, so "unset" is an
		// answer rather than an omission. Anything else the user has set is
		// appended — including variables we do not model (NODE_OPTIONS, npm's
		// npm_config_*), because on a misbehaving machine the one nobody thought
		// to look at is usually the culprit.
		const detail = proxyEnvSummary()
			.map((v) => `${v.name}=${v.value ?? "unset"}`)
			.join(" · ");

		const problems: string[] = [];
		if (hasProxyConfigured(env) && proxyAutoEnabled()) {
			// We turned it on for this process, so proxying genuinely works right
			// now — but npm and the agents are separate processes that inherit the
			// user's shell, not ours.
			problems.push(
				"NODE_USE_ENV_PROXY was not set, so CoDev enabled proxy support for this run. Set NODE_USE_ENV_PROXY=1 in your shell so npm and the agents get it too.",
			);
		} else if (hasProxyConfigured(env) && !env.useEnvProxy) {
			problems.push(
				"A proxy is set but NODE_USE_ENV_PROXY is not — Node ignores proxy environment variables without it. Set NODE_USE_ENV_PROXY=1.",
			);
		}
		const noProxyEntry = matchingNoProxyEntry(env, host);
		if (noProxyEntry) {
			problems.push(
				`NO_PROXY contains "${noProxyEntry}", which sends ${host} traffic direct instead of through the proxy. This is the documented cause of "Login failed" — remove that entry.`,
			);
		}
		if (env.tlsRejectUnauthorized === "0") {
			problems.push(
				"NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification for every connection. It works, but it is a troubleshooting setting — prefer NODE_USE_SYSTEM_CA=1 or NODE_EXTRA_CA_CERTS once your root CA is available.",
			);
		}
		if (hasProxyConfigured(env) && !env.useSystemCa) {
			problems.push(
				"A proxy is set but NODE_USE_SYSTEM_CA is not. Intercepting proxies re-sign TLS with a corporate root that Node does not trust by default; set NODE_USE_SYSTEM_CA=1.",
			);
		}

		if (problems.length === 0) {
			return { status: "pass", detail };
		}
		return { status: "warn", detail, fix: problems.join("\n") };
	},
};

// Ink gates every keyboard prompt on `stdin.isTTY` alone, so a terminal that
// isn't a Win32 console makes `install`, `config` and `model` impossible — the
// dispatcher now refuses them outright. This check is what tells the user why,
// and it is the reason `doctor` deliberately stays runnable without a keyboard.
const terminalCheck: Check = {
	key: "terminal",
	label: "Interactive terminal",
	group: "environment",
	run: async () => {
		const detail = describeStdin();
		if (rawModeSupported()) return { status: "pass", detail };

		const kind = stdinKind();
		// Git Bash is graded a failure, the other two a warning, and the split is
		// about intent rather than severity: a piped stdin or a CI runner is
		// non-interactive because someone chose that, and failing the run over it
		// would make `doctor` red in every pipeline. Git Bash, by contrast, is a
		// user sitting at a keyboard who will be stopped dead by `codevhub install`
		// — exactly the pre-flight failure this command exists to surface.
		if (kind !== "msys") {
			return {
				status: "warn",
				detail,
				fix: terminalFix("install"),
			};
		}
		return {
			status: "fail",
			detail,
			fix: terminalFix("install"),
			diagnosis: {
				what: "This terminal cannot provide the keyboard input that `codevhub install` needs.",
				cause: terminalCause(),
				fix: terminalFix("install"),
				context: [
					`${process.platform} ${process.arch} · node ${process.version}`,
					"Ink enables raw mode only when process.stdin is a TTY",
				],
				raw: terminalEvidence(),
			},
		};
	},
};

// Windows only. CoDev Code clears ENABLE_PROCESSED_INPUT on the shared console
// while it runs, so ctrl+c arrives as a keypress its own double-ctrl+c exit can
// handle. When that guard doesn't take, ctrl+c stays a console break delivered
// to every process attached to the console — including the cmd.exe shims in the
// launch chain, which stop at "Terminate batch job (Y/N)?" instead of exiting,
// and the terminal looks frozen.
//
// The agent reports its own verdict (`codev debug console`): it runs under Bun
// and owns the FFI that reads the console mode, and it installs the real guard
// to check that clearing the bit actually sticks. This check only relays that.
const consoleCtrlCCheck: Check = {
	key: "console-ctrl-c",
	label: "Console ctrl+c handling",
	group: "environment",
	run: async () => {
		if (process.platform !== "win32")
			return { status: "skip", detail: "Windows-only check." };
		if (!stdinApi.isTty())
			return {
				status: "skip",
				detail:
					"stdin is not a console, so the console mode can't be read. Re-run from an interactive terminal.",
			};
		const agent = resolveAgentPath(CLI["codev-code"]);
		if (!agent)
			return {
				status: "skip",
				detail: "CoDev Code is not installed. Run `codevhub install`.",
			};

		// Resolved path, not the bare name: the bare name would re-enter our own
		// PATH shim and relaunch the agent through the hub.
		const probe = await execAsync(agent, ["debug", "console", "--json"], {
			inheritStdin: true,
		});
		const report = parseConsoleReport(probe.stdout);
		if (!report)
			return {
				status: "skip",
				detail:
					"This CoDev Code build has no `debug console` command. Run `codevhub update`.",
			};
		if (report.guardEffective)
			return {
				status: "pass",
				detail: `ctrl+c reaches the agent as a keypress (${report.terminal}).`,
			};

		const cause = !report.ffi
			? "CoDev Code could not read the console mode at all (kernel32 dlopen or GetConsoleMode failed)."
			: !report.guardInstalled
				? "CoDev Code could not install its ctrl+c guard on this console."
				: "The guard installed but ENABLE_PROCESSED_INPUT stayed set, so something is re-applying it.";
		return {
			status: "fail",
			detail: `ctrl+c will reach this console as a break event (${report.terminal}).`,
			fix: "Quitting may hang. Until this is fixed, quit with `/exit` instead of ctrl+c, and report this doctor output.",
			diagnosis: {
				what: "ctrl+c is not being delivered to CoDev Code as a keypress.",
				cause,
				fix: "Report this output — the console mode line is the part that matters.",
				context: [
					`${process.platform} ${process.arch} · terminal ${report.terminal}`,
					`console mode ${report.mode.before ?? "?"} -> ${report.mode.guarded ?? "?"} (guarded)`,
				],
				raw: probe.stdout.trim().split("\n"),
			},
		};
	},
};

interface ConsoleReport {
	terminal: string;
	ffi: boolean;
	guardInstalled: boolean;
	guardEffective: boolean;
	mode: { before: string | null; guarded: string | null };
}

// Returns undefined for anything that isn't the report — a build predating the
// subcommand answers with yargs' usage text on stderr and an empty stdout.
function parseConsoleReport(stdout: string): ConsoleReport | undefined {
	const parsed: unknown = (() => {
		try {
			return JSON.parse(stdout.trim() || "null");
		} catch {
			return null;
		}
	})();
	if (!parsed || typeof parsed !== "object") return undefined;
	const report = parsed as Partial<ConsoleReport>;
	if (typeof report.guardEffective !== "boolean") return undefined;
	return report as ConsoleReport;
}

const systemCaCheck: Check = {
	key: "system-ca",
	label: "System certificate store",
	group: "environment",
	run: async () => {
		if (!tlsApi.supported()) {
			return {
				status: "warn",
				detail: `Node ${process.version} cannot read the OS certificate store.`,
				fix: `Upgrade to Node ${RECOMMENDED_NODE}, or set NODE_EXTRA_CA_CERTS to your organization's root CA (a PEM file).`,
			};
		}
		let count = 0;
		try {
			count = tlsApi.getCACertificates("system").length;
		} catch {
			count = 0;
		}
		if (count === 0) {
			return {
				status: "warn",
				detail: "The OS certificate store is empty or unreadable.",
				fix: "If you are behind a TLS-intercepting proxy, ask IT for the root CA (PEM) and set NODE_EXTRA_CA_CERTS to its path.",
			};
		}
		return {
			status: "pass",
			detail: `${count} certificates readable from the OS trust store.`,
		};
	},
};

/**
 * The subset cheap enough to run at the head of `codevhub install`.
 *
 * Strictly pure: reads `process.versions` and `process.env` and nothing else.
 * Everything excluded here is excluded for a concrete reason, not for tidiness:
 *
 *   - the npm checks each spawn `npm config get`, ~300ms apiece, and `install`
 *     runs npm for real moments later anyway — a broken npm surfaces there with
 *     the same diagnosis;
 *   - `system-ca` reads the OS trust store, which is ~20ms on macOS but 300ms+
 *     on Windows where it BLOCKS THE EVENT LOOP. lib/tls.ts documents exactly
 *     this: an earlier revision paid that cost eagerly and stalled Ink's render
 *     timers badly enough to fail timing-sensitive tests that never fetch.
 *   - `terminal` is pure and would qualify on cost, but it can never fail here:
 *     index.tsx refuses `install`/`config` before Ink is even rendered, so by
 *     the time this list runs the answer is always "pass". It belongs to
 *     `doctor`, which is reachable without a keyboard precisely so it can
 *     report that verdict.
 *
 * `codevhub doctor` runs the full set, where a second of latency is the point.
 */
export const PREFLIGHT_CHECKS: Check[] = [nodeVersionCheck, proxyEnvCheck];

export const ENVIRONMENT_CHECKS: Check[] = [
	nodeVersionCheck,
	terminalCheck,
	consoleCtrlCCheck,
	npmAvailableCheck,
	npmPrefixCheck,
	npmRegistryCheck,
	proxyEnvCheck,
	systemCaCheck,
];

// ---------------------------------------------------------------------------
// Group 2 — network (transport only, no auth)
// ---------------------------------------------------------------------------

// Probe a route the CLI actually calls, not the API base path. `/codev-backend`
// on its own is not an endpoint — the gateway 301s it to an internal-only
// origin, so it measured something no CoDev command ever does. `POST /config`
// answers 401 without a token, which proves DNS, TCP, TLS and the real API
// route in one round trip.
const backendReachCheck: Check = {
	key: "backend-reach",
	label: "Reach the CoDev backend",
	group: "network",
	run: () => reach(`${BACKEND_URL}/config`, backendHost(), "POST"),
};

const npmReachCheck: Check = {
	key: "npm-reach",
	label: "Reach the npm registry",
	group: "network",
	run: async () => {
		const ping = await execAsync("npm", ["ping"]);
		if (ping.error) {
			const diagnosis = diagnoseExec(
				"npm ping",
				ping.error.code ?? null,
				ping.stderr,
				ping.error.code === "ENOENT",
			);
			return {
				status: "fail",
				detail: diagnosis.what,
				fix: diagnosis.fix,
				diagnosis,
			};
		}
		// A ping proves the registry answers; a real metadata read proves the
		// proxy will let a package through.
		const view = await execAsync("npm", ["view", SELF_PKG, "version"]);
		if (view.error) {
			const diagnosis = diagnoseExec(
				`npm view ${SELF_PKG} version`,
				view.error.code ?? null,
				view.stderr,
				view.error.code === "ENOENT",
			);
			return {
				status: "fail",
				detail: diagnosis.what,
				fix: diagnosis.fix,
				diagnosis,
			};
		}
		return {
			status: "pass",
			detail: `Registry reachable; ${SELF_PKG}@${view.stdout.trim()} is installable.`,
		};
	},
};

export const NETWORK_CHECKS: Check[] = [backendReachCheck, npmReachCheck];

// ---------------------------------------------------------------------------
// Group 3 — account (needs SSO). The login step itself is the <Login>
// component, mounted by DoctorApp; these run once it resolves.
// ---------------------------------------------------------------------------

const apiKeyCheck: Check = {
	key: "api-key",
	label: "Fetch a gateway API key",
	group: "account",
	run: async (ctx) => {
		if (!ctx.accessToken) {
			return { status: "skip", detail: "Skipped — sign-in did not complete." };
		}
		const attempt = { url: `${BACKEND_URL}/auth/exchange`, method: "POST" };
		return guard(attempt, async () => {
			const key = await fetchApiKey(ctx.accessToken as string);
			if (!key) {
				return {
					status: "fail",
					detail: "The backend returned an empty API key.",
					fix: "Your account may not be provisioned for the gateway yet — contact the CoDev team.",
				};
			}
			ctx.apiKey = key;
			return { status: "pass", detail: "API key issued." };
		});
	},
};

const configCheck: Check = {
	key: "codev-config",
	label: "Fetch CoDev configuration",
	group: "account",
	run: async (ctx) => {
		if (!ctx.accessToken) {
			return { status: "skip", detail: "Skipped — sign-in did not complete." };
		}
		const attempt = { url: `${BACKEND_URL}/config`, method: "POST" };
		return guard(attempt, async () => {
			const config = await fetchCodevConfig(ctx.accessToken as string);
			ctx.gatewayUrl = config.gatewayUrl;
			ctx.analysisBackendUrl = config.analysisBackendUrl;
			return {
				status: "pass",
				detail: `Gateway ${config.gatewayUrl}.`,
			};
		});
	},
};

const analysisBackendCheck: Check = {
	key: "analysis-backend-reach",
	label: "Reach the analysis backend (log upload)",
	group: "account",
	run: async (ctx) => {
		if (!ctx.accessToken) {
			return { status: "skip", detail: "Skipped — sign-in did not complete." };
		}
		const attempt = {
			url: `${BACKEND_URL}/supabase/exchange`,
			method: "POST",
		};
		return guard(attempt, async () => {
			await fetchAnalysisBackendSession(ctx.accessToken as string);
			// The analysis backend is a different host from the backend and the
			// gateway, so it can be blocked independently. `codevhub upload`
			// depends on it.
			if (ctx.analysisBackendUrl) {
				const r = await reach(ctx.analysisBackendUrl, "the analysis backend");
				if (r.status !== "pass") return r;
			}
			return {
				status: "pass",
				detail: "Analysis backend session issued and reachable.",
			};
		});
	},
};

export const ACCOUNT_CHECKS: Check[] = [
	apiKeyCheck,
	configCheck,
	analysisBackendCheck,
];

// ---------------------------------------------------------------------------
// Group 4 — LLM
// ---------------------------------------------------------------------------

// Every call below passes ctx.gatewayUrl explicitly. Omitting it makes
// backend.ts fall back to AI_GATEWAY_URL(), which reads `gateway_url` out of
// ~/.codev-hub/auth.json and throws when it is absent — so on a machine that
// has never run `codevhub install`, exactly the audience this command exists
// for, all three checks failed with "Run `codevhub install`". Circular advice
// from a pre-flight tool, and wrong: the config check fetched the URL one step
// earlier. `doctor` never writes that cache, so the value has to be threaded.
const gatewayKeyCheck: Check = {
	key: "gateway-key",
	label: "Validate the gateway key",
	group: "llm",
	run: async (ctx) => {
		if (!ctx.apiKey) {
			return { status: "skip", detail: "Skipped — no API key to validate." };
		}
		if (!ctx.gatewayUrl) {
			return {
				status: "skip",
				detail: "Skipped — the gateway URL could not be fetched.",
			};
		}
		const attempt = { url: `${ctx.gatewayUrl}/v1/models`, method: "GET" };
		return guard(attempt, async () => {
			const ok = await validateApiKey(ctx.apiKey as string, ctx.gatewayUrl);
			return ok
				? { status: "pass", detail: "Key accepted by the gateway." }
				: {
						status: "fail",
						detail: "The gateway rejected the key (401/403).",
						fix: "Run `codevhub login --force` to mint a fresh key, then re-run.",
					};
		});
	},
};

const modelsCheck: Check = {
	key: "gateway-models",
	label: "List available models",
	group: "llm",
	run: async (ctx) => {
		if (!ctx.apiKey) {
			return { status: "skip", detail: "Skipped — no API key." };
		}
		if (!ctx.gatewayUrl) {
			return {
				status: "skip",
				detail: "Skipped — the gateway URL could not be fetched.",
			};
		}
		const attempt = { url: `${ctx.gatewayUrl}/v1/models`, method: "GET" };
		return guard(attempt, async () => {
			const models = await fetchModels(ctx.apiKey as string, ctx.gatewayUrl);
			ctx.models = models;
			const preview = models.slice(0, 3).join(", ");
			return {
				status: "pass",
				detail: `${models.length} models available (${preview}${
					models.length > 3 ? ", …" : ""
				}).`,
			};
		});
	},
};

// The only check that proves inference is actually permitted: /v1/models
// succeeds for a key that is then 403'd on every completion.
const completionCheck: Check = {
	key: "llm-completion",
	label: "Send a test request to the LLM",
	group: "llm",
	run: async (ctx) => {
		if (!ctx.apiKey) {
			return { status: "skip", detail: "Skipped — no API key." };
		}
		if (!ctx.gatewayUrl) {
			return {
				status: "skip",
				detail: "Skipped — the gateway URL could not be fetched.",
			};
		}
		const model = ctx.models?.[0] ?? FALLBACK_MODEL;
		// smokeTestModel never throws — it returns a reason string.
		const reason = await smokeTestModel(ctx.apiKey, model, ctx.gatewayUrl);
		if (!reason) {
			return { status: "pass", detail: `${model} answered a test prompt.` };
		}
		// It stringifies its own errors, so a transport failure arrives as
		// "Couldn't reach the gateway to test X: fetch failed" — the exact bare
		// message this command exists to eliminate. Diagnose that case properly
		// rather than echoing it; the underlying error object is gone by now, but
		// the model-list check immediately above hit the same host and carries the
		// full chain.
		if (/^Couldn't reach the gateway/.test(reason)) {
			const host = hostOf(ctx.gatewayUrl) ?? "the gateway";
			return {
				status: "fail",
				detail: `Could not reach the gateway at ${host} to run a test completion.`,
				fix: "Fix gateway connectivity first — see the model list check above for the underlying network error.",
				diagnosis: {
					what: `Could not reach the gateway at ${host} to run a test completion.`,
					cause:
						"The request never got a response, so this is a connectivity problem rather than a model-permissions one.",
					fix: "The model list check above hit the same host and reports the underlying network error — fix that first, then re-run.",
					context: connectionContext({
						url: `${ctx.gatewayUrl}/v1/chat/completions`,
						method: "POST",
					}),
					raw: [redactSecrets(reason)],
				},
			};
		}
		return {
			status: "fail",
			detail: reason,
			fix: "The key exists but cannot run this model. Check model entitlement, budget, and any region/IP restrictions with the CoDev team.",
			diagnosis: {
				what: `The gateway refused a real completion for ${model}.`,
				cause:
					"Listing models only proves the key exists. This is the error your agents would hit on their first message — model entitlement, an exhausted budget, or an edge/WAF block.",
				fix: "Contact the CoDev team with the response below; it distinguishes a permissions problem from a budget one.",
				context: connectionContext({
					url: `${ctx.gatewayUrl ?? ""}/v1/chat/completions`,
					method: "POST",
				}),
				raw: [redactSecrets(reason)],
			},
		};
	},
};

export const LLM_CHECKS: Check[] = [
	gatewayKeyCheck,
	modelsCheck,
	completionCheck,
];

// ---------------------------------------------------------------------------
// Group 5 — state (informational; never fails, never blocks)
// ---------------------------------------------------------------------------

const NPM_TOOLS: NpmTool[] = ["codev-code", "claude-code", "codex", "opencode"];

const installedAgentsCheck: Check = {
	key: "installed-agents",
	label: "Agents installed",
	group: "state",
	run: async () => {
		// Resolve the global root ONCE. `detectInstalledViaNpm` looks it up per
		// call, so a loop over four agents spawned `npm root -g` four times, in
		// series, for an answer that cannot differ between them — about a second
		// of pure waste in a command people run while already frustrated.
		const root = await npmGlobalRoot();
		if (!root) {
			return {
				status: "skip",
				detail: "Could not resolve npm's global directory.",
			};
		}
		const found = NPM_TOOLS.filter((tool) =>
			existsSync(join(root, ...PKG[tool].split("/"))),
		).map((tool) => `${PKG[tool]} (${CLI[tool]})`);
		return found.length > 0
			? { status: "pass", detail: found.join(", ") }
			: {
					status: "skip",
					detail: "None — `codevhub install` has not run yet.",
				};
	},
};

const configuredAgentsCheck: Check = {
	key: "configured-agents",
	label: "CoDev-managed configs",
	group: "state",
	run: async () => {
		const tools = detectConfiguredTools();
		if (tools.length === 0) {
			return { status: "skip", detail: "None." };
		}
		const withBackups = tools.filter((tool: Tool) =>
			getBackupStatus(tool).some((s) => s.hasBackup),
		);
		return {
			status: "pass",
			detail: `${tools.join(", ")}${
				withBackups.length > 0
					? ` · backups exist for ${withBackups.join(", ")}`
					: " · no backups"
			}`,
		};
	},
};

const shimsCheck: Check = {
	key: "shims",
	label: "PATH shims",
	group: "state",
	run: async () => {
		const shims = detectInstalledShims();
		return shims.length > 0
			? { status: "pass", detail: shims.join(", ") }
			: { status: "skip", detail: "None installed." };
	},
};

const editorCliCheck: Check = {
	key: "editor-clis",
	label: "Editor CLIs",
	group: "state",
	run: async () => {
		const found = ["code", "idea", "pycharm", "webstorm"].filter((cmd) =>
			agentOnPath(cmd),
		);
		return found.length > 0
			? { status: "pass", detail: `${found.join(", ")} on PATH.` }
			: {
					status: "skip",
					detail:
						"None on PATH — editor extension installs will be skipped with a warning.",
				};
	},
};

const savedKeyCheck: Check = {
	key: "saved-key",
	label: "Saved credentials",
	group: "state",
	run: async () => {
		const saved = loadApiKey();
		if (!saved?.apiKey) {
			return { status: "skip", detail: "No API key saved yet." };
		}
		return {
			status: "pass",
			detail: `Key saved${saved.model ? ` · model ${saved.model}` : ""}${
				saved.providerName ? ` · provider ${saved.providerName}` : ""
			}.`,
		};
	},
};

export const STATE_CHECKS: Check[] = [
	installedAgentsCheck,
	configuredAgentsCheck,
	shimsCheck,
	editorCliCheck,
	savedKeyCheck,
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a group of checks in order, mirroring each result into the diagnostic
 * log. A check must never throw — but if one somehow does, it becomes a `fail`
 * rather than taking the whole command down.
 */
export async function runChecks(
	checks: Check[],
	ctx: DoctorContext,
	onResult?: (outcome: CheckOutcome) => void,
): Promise<CheckOutcome[]> {
	const outcomes: CheckOutcome[] = [];
	for (const check of checks) {
		// Checks run strictly in sequence, so anything the recorders gain while
		// one is running belongs to it. That makes attribution exact without
		// threading a context through every call site — and it still works for a
		// check that fans out internally (npm-registry runs five `npm config get`
		// concurrently; all five land on its row).
		const commandsBefore = commandLog.entries.length;
		const requestsBefore = requestLog.entries.length;

		let result: CheckResult;
		try {
			result = await check.run(ctx);
		} catch (err) {
			const diagnosis = diagnoseError(err);
			result = {
				status: "fail",
				detail: diagnosis.what,
				fix: diagnosis.fix,
				diagnosis,
			};
		}
		const outcome: CheckOutcome = {
			...result,
			key: check.key,
			label: check.label,
			group: check.group,
			activity: collectActivity(commandsBefore, requestsBefore),
		};
		logCheck(outcome);
		outcomes.push(outcome);
		onResult?.(outcome);
	}
	return outcomes;
}

function logCheck(outcome: CheckOutcome): void {
	// Everything goes through `extra`, never `unsafeUnredacted` — raw error
	// bodies can carry bearer tokens and must stay scrubbed on disk.
	const fields = {
		action: "doctor.check",
		outcome:
			outcome.status === "pass"
				? ("success" as const)
				: outcome.status === "fail"
					? ("failure" as const)
					: undefined,
		extra: {
			key: outcome.key,
			group: outcome.group,
			status: outcome.status,
			detail: outcome.detail,
			fix: outcome.fix,
			diagnosis_raw: outcome.diagnosis?.raw,
			diagnosis_context: outcome.diagnosis?.context,
		},
	};
	const msg = `doctor ${outcome.key}: ${outcome.status}`;
	if (outcome.status === "fail") logError(msg, fields);
	else if (outcome.status === "warn") logWarn(msg, fields);
	else if (outcome.status === "skip") logDebug(msg, fields);
	else logInfo(msg, fields);
}

export function hasFailure(outcomes: CheckOutcome[]): boolean {
	return outcomes.some((o) => o.status === "fail");
}

// ---------------------------------------------------------------------------
// Remediation summary
// ---------------------------------------------------------------------------

/**
 * Per-platform instructions for making proxy settings permanent, so the user
 * can set them up BEFORE running `codevhub install`. Mirrors the install guide.
 */
export function persistProxyInstructions(proxy?: {
	http?: string;
	https?: string;
}): string[] {
	const value = proxy?.https ?? proxy?.http ?? "<PROXY-IP>:<PROXY-PORT>";
	const url = /^https?:\/\//.test(value) ? value : `http://${value}`;
	if (process.platform === "win32") {
		return [
			"Windows (PowerShell) — set these for your user, then open a new terminal:",
			`  [Environment]::SetEnvironmentVariable("HTTP_PROXY", "${url}", "User")`,
			`  [Environment]::SetEnvironmentVariable("HTTPS_PROXY", "${url}", "User")`,
			'  [Environment]::SetEnvironmentVariable("NODE_USE_ENV_PROXY", "1", "User")',
			'  [Environment]::SetEnvironmentVariable("NODE_USE_SYSTEM_CA", "1", "User")',
			"",
			"npm keeps its own proxy configuration, separate from the above:",
			`  npm config set proxy ${url}`,
			`  npm config set https-proxy ${url}`,
			`  npm config set registry ${INTERNAL_NPM_REGISTRY}`,
		];
	}
	return [
		"Linux / macOS — add these to ~/.bashrc or ~/.zshrc, then `source` it:",
		`  export HTTP_PROXY=${url}`,
		`  export HTTPS_PROXY=${url}`,
		"  export NODE_USE_ENV_PROXY=1",
		"  export NODE_USE_SYSTEM_CA=1",
		"",
		"npm keeps its own proxy configuration, separate from the above:",
		`  npm config set proxy ${url}`,
		`  npm config set https-proxy ${url}`,
		`  npm config set registry ${INTERNAL_NPM_REGISTRY}`,
	];
}

/**
 * The "Next steps" block: every unresolved issue in order, then the persistent
 * setup instructions. Printed whenever anything failed or warned, because the
 * point of the command is to leave the user able to fix things before
 * `codevhub install`.
 */
export function buildNextSteps(
	outcomes: CheckOutcome[],
	proxy?: { http?: string; https?: string },
): string[] {
	const actionable = outcomes.filter(
		(o) => (o.status === "fail" || o.status === "warn") && o.fix,
	);
	if (actionable.length === 0) return [];

	const lines: string[] = [];
	for (const [i, o] of actionable.entries()) {
		lines.push(
			`${i + 1}. ${o.label} — ${o.status === "fail" ? "FAILED" : "warning"}`,
		);
		for (const fixLine of (o.fix ?? "").split("\n")) {
			lines.push(`   ${fixLine}`);
		}
	}

	// Only append the proxy setup block when something actually points at the
	// network. Keying off the group alone treated a plain expired-token 401 as
	// a proxy problem and buried the real instruction ("log in again") under a
	// wall of export lines. A transport failure anywhere still qualifies —
	// diagnoseError puts the proxy variables in its `fix`, so that is the
	// signal rather than the group.
	// Match the environment variable names, not the word "proxy" — the npm
	// mirror's own URL ends in `/npm-proxy`, so a loose /proxy/i match pulled
	// the whole block in on a run whose only issue was the registry setting.
	const NAMES_PROXY_ENV = /\b(?:HTTPS?_PROXY|NODE_USE_ENV_PROXY)\b/;
	const proxyRelated = outcomes.some(
		(o) =>
			o.status !== "pass" &&
			(o.key === "proxy-env" ||
				o.group === "network" ||
				NAMES_PROXY_ENV.test(o.fix ?? "")),
	);
	if (proxyRelated) {
		lines.push("");
		lines.push(...persistProxyInstructions(proxy));
	}

	lines.push("");
	lines.push(
		"Re-run `codevhub doctor` to confirm, then run `codevhub install`.",
	);
	return lines;
}

// ---------------------------------------------------------------------------
// Report file
// ---------------------------------------------------------------------------

export interface DoctorReport {
	generatedAt: string;
	codevVersion: string;
	node: { version: string; platform: string; arch: string };
	proxy: ProxyEnv & {
		autoEnabledByCodev: boolean;
		/**
		 * The proxy/TLS environment as reported to the user: the core variables
		 * always, with `null` for unset, plus anything else that is set.
		 */
		environment: ProxyEnvVar[];
	};
	summary: {
		ok: boolean;
		passed: number;
		warned: number;
		failed: number;
		skipped: number;
	};
	checks: CheckOutcome[];
	/** Every child process this run spawned, in order. */
	commands: CommandRecord[];
	/** Every HTTP request this run made, in order. */
	requests: RequestRecord[];
	nextSteps: string[];
}

/**
 * Start recording the commands this run spawns.
 *
 * Called once at the top of the run: `doctor` executes things on someone
 * else's machine, often a locked-down one, and "what did it just run?" should
 * be answerable from the output rather than from the source.
 */
export function startCommandRecording(): void {
	recordCommands();
	recordRequests();
}

export function recordedCommands(): CommandRecord[] {
	return [...commandLog.entries];
}

export function recordedRequests(): RequestRecord[] {
	return [...requestLog.entries];
}

/**
 * Everything the recorders gained since the given offsets, as display lines.
 *
 * Returns undefined rather than an empty array when a check ran nothing, so
 * the renderer has one falsy thing to test and the report file stays free of
 * empty `activity: []` noise on the many checks that are pure logic.
 */
export function collectActivity(
	commandsBefore: number,
	requestsBefore: number,
): CheckActivity[] | undefined {
	const activity: CheckActivity[] = [
		...commandLog.entries.slice(commandsBefore).map((c) => ({
			kind: "command" as const,
			detail: c.command,
			durationMs: c.durationMs,
		})),
		...requestLog.entries.slice(requestsBefore).map((r) => {
			// Naming the proxy the request actually went through is the difference
			// between "this endpoint is unreachable" and "your proxy could not
			// reach this endpoint" — and it is the only way to see, per request,
			// that a NO_PROXY entry quietly sent one of them direct.
			const via = proxyForUrl(r.url);
			return {
				kind: "request" as const,
				// The status belongs on the line: it is what distinguishes "the
				// endpoint answered no" from "nothing answered at all".
				detail: `${r.method} ${r.url} → ${r.status ?? "no response"}${
					via ? ` via ${via}` : ""
				}`,
				durationMs: r.durationMs,
			};
		}),
	];
	return activity.length > 0 ? activity : undefined;
}

/** Snapshot of the recorders, for callers attributing work done outside runChecks. */
export function activityMark(): { commands: number; requests: number } {
	return {
		commands: commandLog.entries.length,
		requests: requestLog.entries.length,
	};
}

function maskProxyEnv(env: ProxyEnv): ProxyEnv {
	return {
		...env,
		httpProxy: env.httpProxy ? maskProxyCredentials(env.httpProxy) : null,
		httpsProxy: env.httpsProxy ? maskProxyCredentials(env.httpsProxy) : null,
	};
}

export function buildDoctorReport(
	outcomes: CheckOutcome[],
	generatedAt: string,
	proxyUsed?: { http?: string; https?: string },
): DoctorReport {
	const count = (s: CheckStatus) =>
		outcomes.filter((o) => o.status === s).length;
	return {
		generatedAt,
		codevVersion: VERSION,
		node: {
			version: process.version,
			platform: process.platform,
			arch: process.arch,
		},
		// Credentials masked: the report is written to be attached to tickets.
		proxy: {
			...maskProxyEnv(readProxyEnv()),
			autoEnabledByCodev: proxyAutoEnabled(),
			environment: proxyEnvSummary(),
		},
		summary: {
			ok: !hasFailure(outcomes),
			passed: count("pass"),
			warned: count("warn"),
			failed: count("fail"),
			skipped: count("skip"),
		},
		checks: outcomes,
		commands: recordedCommands(),
		requests: recordedRequests(),
		nextSteps: buildNextSteps(outcomes, proxyUsed),
	};
}

/**
 * Write the machine-readable report to ~/.codev-hub/doctor-report.json,
 * replacing any previous one.
 *
 * Best-effort by construction, matching the logging discipline in lib/log.ts:
 * a diagnostic that breaks the command it is diagnosing is worse than no
 * diagnostic. Returns the path on success, null if anything went wrong.
 *
 * The serialized JSON goes through the same secret scrubbing as the terminal
 * output and the NDJSON log — this file exists to be attached to tickets, so
 * it is the *last* place a token should survive. Scrubbing after
 * stringification is safe: every replacement is plain text and none of the
 * patterns can match across a JSON quote or escape.
 */
export function writeDoctorReport(report: DoctorReport): string | null {
	try {
		const path = doctorReportPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			`${redactSecrets(JSON.stringify(report, null, 2))}\n`,
			"utf-8",
		);
		logInfo("wrote doctor report", {
			action: "doctor.report",
			outcome: "success",
			extra: { checks: report.checks.length, ok: report.summary.ok },
		});
		return path;
	} catch (err) {
		logWarn("could not write the doctor report", {
			action: "doctor.report",
			outcome: "failure",
			err,
		});
		return null;
	}
}

// ---------------------------------------------------------------------------
// Re-exec handoff
//
// DoctorApp cannot spawn the retry itself: spawnSync with inherited stdio while
// Ink still owns the TTY corrupts the terminal. Instead the app records its
// intent here and exits; index.tsx reads it after waitUntilExit() resolves.
// Same shape of indirection as reexec.ts.
// ---------------------------------------------------------------------------

export interface DoctorOutcome {
	exitCode: number;
	/** Set when the user supplied a proxy and wants the checks re-run with it. */
	retryWithProxy: { http: string; https: string } | null;
}

export const doctorOutcome: DoctorOutcome = {
	exitCode: 0,
	retryWithProxy: null,
};

export function resetDoctorOutcome(): void {
	doctorOutcome.exitCode = 0;
	doctorOutcome.retryWithProxy = null;
}

/**
 * Normalize a user-typed `host:port` into a proxy URL.
 *
 * Accepts an IPv4 address, a hostname, or a bracketed IPv6 literal, with or
 * without a scheme and with optional `user:pass@` credentials. Returns null for
 * anything unusable, which the prompt turns into an inline error.
 */
export function normalizeProxyInput(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	// A bare number is the likely mistake when the prompt asks for "host:port" —
	// and it is the dangerous one, because WHATWG URL parses integers as 32-bit
	// IPv4 addresses: `8080` becomes `http://0.0.31.144`. That is accepted
	// silently and then fails much later as an unexplained connection timeout to
	// an address the user never typed. Reject it here, where we can still say why.
	if (/^\d+$/.test(trimmed.replace(/^https?:\/\//i, ""))) return null;
	const withScheme = /^https?:\/\//i.test(trimmed)
		? trimmed
		: `http://${trimmed}`;
	try {
		const url = new URL(withScheme);
		if (!url.hostname) return null;
		return url.toString().replace(/\/$/, "");
	} catch {
		return null;
	}
}

/** Set when doctor has already retried, so the prompt is offered only once. */
export const DOCTOR_PROXY_ENV = "CODEV_DOCTOR_PROXY";

export function alreadyRetriedWithProxy(): boolean {
	const v = process.env[DOCTOR_PROXY_ENV];
	return v !== undefined && v !== "" && v !== "0";
}

/**
 * Re-run `codevhub doctor` with the proxy the user just typed, so they see the
 * fix actually work before being told to make it permanent. Nothing is written
 * to disk — the settings live only in the child's environment.
 *
 * Lives here rather than in index.tsx so the exact command and environment are
 * assertable; the dispatcher only decides *when* to call it. It must still be
 * invoked from index.tsx after Ink has unmounted: `spawnSync` with inherited
 * stdio while Ink owns the TTY corrupts the terminal.
 */
export function rerunDoctorWithProxy(
	proxy: { http: string; https: string },
	args: string[],
): number {
	const selfPath = process.argv[1];
	if (!selfPath) {
		process.stderr.write("Could not determine the CLI path to re-run.\n");
		return 1;
	}
	const traceId = currentTraceId();
	const env: NodeJS.ProcessEnv = { ...process.env };
	// Assigned through overrideEnvVar rather than spread: Windows environment
	// variables are case-insensitive, so a user's existing `http_proxy` would
	// survive alongside our `HTTP_PROXY` and the child could pick up the stale
	// address — testing a proxy the user did not type.
	overrideEnvVar(env, "HTTP_PROXY", proxy.http);
	overrideEnvVar(env, "HTTPS_PROXY", proxy.https);
	overrideEnvVar(env, "NODE_USE_ENV_PROXY", "1");
	// Intercepting proxies re-sign TLS with a corporate root, so reading the
	// OS trust store is part of "try it with the proxy", not a separate step.
	overrideEnvVar(env, "NODE_USE_SYSTEM_CA", "1");
	// Offer the prompt only once — if the retry still fails, the summary must
	// be allowed to print rather than asking again.
	overrideEnvVar(env, DOCTOR_PROXY_ENV, "1");
	if (traceId) overrideEnvVar(env, "CODEV_TRACE_PARENT", traceId);

	// A NO_PROXY entry covering our own backend would send that traffic direct
	// and defeat the proxy we're testing — the documented cause of "Login
	// failed". Drop it for the child only; the user's environment is untouched.
	// Every spelling is stripped, since any of them would defeat the retry.
	const host = backendHost();
	for (const key of envVarKeys(env, "NO_PROXY")) {
		const value = env[key];
		if (value) env[key] = stripNoProxyFor(value, host);
	}

	// execArgv is forwarded so the child keeps whatever flags this process was
	// started with — without it, a `pnpm dev` run (node + tsx loader flags)
	// would spawn a child that cannot load TypeScript and dies immediately.
	const result = spawner.spawnSync(
		process.execPath,
		[...process.execArgv, selfPath, "doctor", ...args],
		{ stdio: "inherit", env },
	);
	return result.status ?? 1;
}
