import {
	type AuthData,
	ensureInteractiveAuth,
	type InteractiveAuthCallbacks,
} from "@/lib/auth.js";
import { BACKEND_URL } from "@/lib/const.js";
import { loggedFetch } from "@/lib/log.js";
import {
	READINESS_RUBRIC,
	READINESS_RUBRIC_VERSION,
} from "@/lib/readiness-contract.js";
import { validateProfileRules } from "@/lib/readiness-rules.js";

const PROFILE_TIMEOUT_MS = 10_000;
const MAX_CRITERIA = 200;
const KEY = /^[a-z][a-z0-9_]{0,63}$/;

export interface ReadinessCriterionConfig {
	key: string;
	name: string;
	category: string;
	description: string;
	maturityLevel: number;
	repositoryScope: string;
	enabled: boolean;
	order: number;
	passCondition: string;
	evidenceRequirement: string;
	applicability: unknown;
	evidenceLocators: unknown[];
	decision: unknown;
	priority: number;
}

export interface ReadinessProfileDefinition {
	criteria: ReadinessCriterionConfig[];
}

export interface ReadinessProfileVersion {
	id: string;
	revision: number;
	contentHash: string;
	schemaVersion: string;
	analyzerVersion: string;
	definition: ReadinessProfileDefinition;
}

export interface ReadinessProfile {
	id: string;
	ownerProfileId: string | null;
	name: string;
	slug: string;
	description: string;
	scope: string;
	isDefault: boolean;
	status: string;
	activeVersion: ReadinessProfileVersion;
}

export interface ReadinessProfileSession {
	auth: AuthData;
	profiles: ReadinessProfile[];
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown, field: string, max = 4_000): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new Error(`Readiness profile ${field} is invalid.`);
	return value;
}

function optionalText(value: unknown, field: string, max = 4_000): string {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string" || value.length > max)
		throw new Error(`Readiness profile ${field} is invalid.`);
	return value;
}

function integer(value: unknown, field: string, min = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < min)
		throw new Error(`Readiness profile ${field} is invalid.`);
	return value as number;
}

function decodeCriterion(value: unknown): ReadinessCriterionConfig {
	const item = record(value);
	if (!item) throw new Error("Readiness profile criterion is invalid.");
	const key = text(item.key, "criterion key", 64);
	if (!KEY.test(key))
		throw new Error(`Readiness profile criterion key is unsafe: ${key}.`);
	if (typeof item.enabled !== "boolean")
		throw new Error(`Readiness profile ${key}.enabled is invalid.`);
	if (
		!Array.isArray(item.evidenceLocators) ||
		item.evidenceLocators.length > 20
	)
		throw new Error(`Readiness profile ${key}.evidenceLocators is invalid.`);
	if (!record(item.decision))
		throw new Error(`Readiness profile ${key}.decision is invalid.`);
	return {
		key,
		name: text(item.name, `${key}.name`, 200),
		category: optionalText(item.category, `${key}.category`, 200),
		description: optionalText(item.description, `${key}.description`),
		maturityLevel: integer(item.maturityLevel, `${key}.maturityLevel`, 1),
		repositoryScope: text(item.repositoryScope, `${key}.repositoryScope`, 100),
		enabled: item.enabled,
		order: integer(item.order, `${key}.order`),
		passCondition: optionalText(item.passCondition, `${key}.passCondition`),
		evidenceRequirement: optionalText(
			item.evidenceRequirement,
			`${key}.evidenceRequirement`,
		),
		applicability: item.applicability,
		evidenceLocators: item.evidenceLocators,
		decision: item.decision,
		priority: integer(item.priority, `${key}.priority`),
	};
}

export function decodeReadinessProfile(value: unknown): ReadinessProfile {
	const profile = record(value);
	const version = record(profile?.activeVersion);
	const definition = record(version?.definition);
	if (
		!profile ||
		!version ||
		!definition ||
		!Array.isArray(definition.criteria)
	)
		throw new Error("Readiness profile response is invalid.");
	if (
		definition.criteria.length === 0 ||
		definition.criteria.length > MAX_CRITERIA
	)
		throw new Error("Readiness profile criterion inventory is invalid.");
	const criteria = definition.criteria.map(decodeCriterion);
	const keys = new Set<string>();
	for (const criterion of criteria) {
		if (keys.has(criterion.key))
			throw new Error(`Duplicate readiness criterion: ${criterion.key}.`);
		keys.add(criterion.key);
	}
	const decoded: ReadinessProfile = {
		id: text(profile.id, "id", 200),
		ownerProfileId:
			typeof profile.ownerProfileId === "string"
				? profile.ownerProfileId
				: null,
		name: text(profile.name, "name", 200),
		slug: text(profile.slug, "slug", 200),
		description:
			typeof profile.description === "string" ? profile.description : "",
		scope: text(profile.scope, "scope", 100),
		isDefault: profile.isDefault === true,
		status: text(profile.status, "status", 100),
		activeVersion: {
			id: text(version.id, "version id", 200),
			revision: integer(version.revision, "revision", 1),
			contentHash: text(version.contentHash, "content hash", 256),
			schemaVersion: text(version.schemaVersion, "schema version", 100),
			analyzerVersion: text(version.analyzerVersion, "analyzer version", 100),
			definition: { criteria },
		},
	};
	if (decoded.activeVersion.schemaVersion !== "1")
		throw new Error(
			`Unsupported readiness profile schema: ${decoded.activeVersion.schemaVersion}.`,
		);
	if (decoded.activeVersion.analyzerVersion !== READINESS_RUBRIC_VERSION)
		throw new Error(
			`Unsupported readiness analyzer version: ${decoded.activeVersion.analyzerVersion}.`,
		);
	if (!isStandardProfile(decoded)) validateProfileRules(decoded);
	return decoded;
}

export type ReadinessLoginCallbacks = Pick<
	InteractiveAuthCallbacks,
	"onLoginUrl" | "onManualSubmit"
>;

export async function fetchReadinessProfiles(
	onStatus: (message: string) => void = () => {},
	callbacks: ReadinessLoginCallbacks = {},
): Promise<ReadinessProfileSession> {
	const auth = await ensureInteractiveAuth((message) => {
		onStatus(message);
	}, callbacks).catch((error) => {
		throw new Error(error instanceof Error ? error.message : String(error));
	});
	onStatus("Loading accessible readiness profiles");
	const response = await loggedFetch(
		"readiness.profiles",
		`${BACKEND_URL}/readiness/profiles`,
		{
			headers: { authorization: `Bearer ${auth.access_token}` },
			signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
		},
	);
	if (!response.ok)
		throw new Error(
			`Readiness profile fetch failed (${response.status}): ${await response.text()}`,
		);
	const body = (await response.json()) as unknown;
	const values = Array.isArray(body)
		? body
		: Array.isArray(record(body)?.profiles)
			? (record(body)?.profiles as unknown[])
			: null;
	if (!values) throw new Error("Readiness profile response is invalid.");
	const profiles = values.map(decodeReadinessProfile);
	if (profiles.length === 0)
		throw new Error(
			"No published readiness profile is available to this user.",
		);
	return { auth, profiles };
}

export function selectReadinessProfile(
	profiles: ReadinessProfile[],
	selector?: string,
): ReadinessProfile | undefined {
	if (selector) {
		const matches = profiles.filter(
			(profile) => profile.id === selector || profile.slug === selector,
		);
		if (matches.length !== 1)
			throw new Error(`Readiness profile not found or ambiguous: ${selector}.`);
		return matches[0];
	}
	if (profiles.length === 1) return profiles[0];
	const personalDefault = profiles.find(
		(profile) => profile.isDefault && profile.scope === "personal",
	);
	if (personalDefault) return personalDefault;
	const systemDefaults = profiles.filter(
		(profile) => profile.isDefault && profile.scope === "system",
	);
	return systemDefaults.length === 1 ? systemDefaults[0] : undefined;
}

export function enabledProfileCriteria(
	profile: ReadinessProfile,
): ReadinessCriterionConfig[] {
	return profile.activeVersion.definition.criteria
		.filter((criterion) => criterion.enabled)
		.sort(
			(left, right) =>
				left.order - right.order || left.key.localeCompare(right.key),
		);
}

export function builtInReadinessRuleKey(
	criterion: ReadinessCriterionConfig,
): string | undefined {
	const decision = record(criterion.decision);
	if (decision?.engine !== "builtin") return undefined;
	const ruleKey =
		typeof decision.ruleKey === "string" ? decision.ruleKey : criterion.key;
	if (ruleKey !== criterion.key)
		throw new Error(
			`Readiness built-in rule key for ${criterion.key} does not match its criterion key.`,
		);
	return ruleKey;
}

export function isStandardProfile(profile: ReadinessProfile): boolean {
	return profile.slug === "standard" && profile.scope === "system";
}

export function bundledStandardProfile(): ReadinessProfile {
	return {
		id: "builtin:standard",
		ownerProfileId: null,
		name: "Standard",
		slug: "standard",
		description: "Built-in CoDev Standard readiness profile.",
		scope: "system",
		isDefault: true,
		status: "published",
		activeVersion: {
			id: `builtin:standard@${READINESS_RUBRIC_VERSION}`,
			revision: 1,
			contentHash: READINESS_RUBRIC_VERSION,
			schemaVersion: "1",
			analyzerVersion: READINESS_RUBRIC_VERSION,
			definition: {
				criteria: READINESS_RUBRIC.map((criterion, order) => ({
					key: criterion.id,
					name: criterion.id.replaceAll("_", " "),
					category: criterion.category,
					description: criterion.description,
					maturityLevel: criterion.maturityLevel,
					repositoryScope: "repository",
					enabled: true,
					order,
					passCondition: criterion.description,
					evidenceRequirement: criterion.evidenceRequired,
					applicability: { kind: "always" },
					evidenceLocators: [],
					decision: { engine: "builtin", ruleKey: criterion.id },
					priority: criterion.maturityLevel,
				})),
			},
		},
	};
}
