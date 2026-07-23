import { describe, expect, it } from "vitest";
import {
	bundledStandardProfile,
	decodeReadinessProfile,
	selectReadinessProfile,
} from "@/lib/readiness-profile.js";

describe("readiness profiles", () => {
	it("decodes and freezes the full active version identity", () => {
		const source = structuredClone(bundledStandardProfile());
		const decoded = decodeReadinessProfile(source);
		expect(decoded.activeVersion.id).toBe(source.activeVersion.id);
		expect(decoded.activeVersion.definition.criteria).toHaveLength(82);
	});

	it("selects by id/slug and auto-selects only a sole or unique default", () => {
		const standard = bundledStandardProfile();
		const custom = {
			...structuredClone(standard),
			id: "custom-id",
			slug: "custom",
			name: "Custom",
			isDefault: false,
			activeVersion: { ...standard.activeVersion, id: "custom-version" },
		};
		expect(selectReadinessProfile([standard, custom])?.slug).toBe("standard");
		expect(selectReadinessProfile([standard, custom], "custom-id")?.slug).toBe(
			"custom",
		);
		expect(() => selectReadinessProfile([standard], "missing")).toThrow(
			/not found/,
		);
	});

	it("prefers a personal default over the shared system default", () => {
		const standard = bundledStandardProfile();
		const personal = {
			...structuredClone(standard),
			id: "personal-id",
			ownerProfileId: "user-1",
			slug: "personal",
			scope: "personal",
			activeVersion: { ...standard.activeVersion, id: "personal-version" },
		};
		expect(selectReadinessProfile([standard, personal])?.id).toBe(
			"personal-id",
		);
	});

	it("rejects unsafe or duplicate dynamic criterion keys", () => {
		const profile = structuredClone(bundledStandardProfile());
		const first = profile.activeVersion.definition.criteria[0];
		if (!first) throw new Error("Standard profile fixture is empty.");
		first.key = "__proto__";
		expect(() => decodeReadinessProfile(profile)).toThrow(/unsafe/);
	});

	it("accepts empty optional criterion metadata", () => {
		const profile = structuredClone(bundledStandardProfile());
		profile.slug = "custom";
		const criterion = profile.activeVersion.definition.criteria[0];
		if (!criterion) throw new Error("Standard profile fixture is empty.");
		criterion.category = "";
		criterion.description = "";
		criterion.passCondition = "";
		criterion.evidenceRequirement = "";
		expect(
			decodeReadinessProfile(profile).activeVersion.definition.criteria[0],
		).toMatchObject({
			category: "",
			description: "",
			passCondition: "",
			evidenceRequirement: "",
		});
	});
});
