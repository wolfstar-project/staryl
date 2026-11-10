import { describe, expect, it } from "vitest";
import {
	createReport,
	mergeNamespace,
	placeholders,
	serializeLocale,
} from "../../scripts/lib/merge-locale.ts";

const base = {
	addName: "add",
	addSuccess: "{{GREENTICK}} Following **{{name}}**.",
	statusValues: ["online", "offline"],
	nested: {
		title: "Title",
		count_one: "{{count}} feed",
		count_other: "{{count}} feeds",
	},
};

describe("placeholders", () => {
	it("collects the placeholder names, ignoring formatters", () => {
		expect(placeholders("{{b}} and {{value, orList}} and {{b}}")).toBe(
			"b,value",
		);
	});
});

describe("mergeNamespace", () => {
	it("applies valid translations and keeps placeholders in sync", () => {
		const report = createReport();
		const merged = mergeNamespace(
			undefined,
			{
				addSuccess: "{{GREENTICK}} Seguo **{{name}}**.",
				nested: { title: "Titolo" },
			},
			base,
			report,
		);
		expect(merged).toMatchObject({
			addSuccess: "{{GREENTICK}} Seguo **{{name}}**.",
			nested: { title: "Titolo" },
		});
		expect(report.updated).toEqual(["addSuccess", "nested.title"]);
	});

	it("rejects a translation whose placeholders differ from the base", () => {
		const report = createReport();
		const merged = mergeNamespace(
			{ addSuccess: "old" },
			{ addSuccess: "Seguo **{{nome}}**." },
			base,
			report,
		) as Record<string, unknown>;
		expect(merged.addSuccess).toBe("old");
		expect(report.rejected).toHaveLength(1);
	});

	it("never lets a null or blank value overwrite the committed one", () => {
		const merged = mergeNamespace(
			{ nested: { title: "Titolo" } },
			{ nested: { title: null } },
			base,
			createReport(),
		) as { nested: { title: string } };
		expect(merged.nested.title).toBe("Titolo");
	});

	it("lowercases slash command names and rejects invalid ones", () => {
		const report = createReport();
		const merged = mergeNamespace(
			undefined,
			{ addName: "Aggiungi" },
			base,
			report,
		) as Record<string, string>;
		expect(merged.addName).toBe("aggiungi");

		const rejected = mergeNamespace(
			undefined,
			{ addName: "due parole" },
			base,
			createReport(),
		) as Record<string, string>;
		expect(rejected.addName).toBe("");
	});

	it("applies arrays as a whole only", () => {
		const full = mergeNamespace(
			undefined,
			{ statusValues: ["attivo", "spento"] },
			base,
			createReport(),
		) as Record<string, unknown>;
		expect(full.statusValues).toEqual(["attivo", "spento"]);

		const partial = mergeNamespace(
			undefined,
			{ statusValues: ["attivo", null] },
			base,
			createReport(),
		) as Record<string, unknown>;
		expect(partial.statusValues).toEqual(["", ""]);
	});

	it("keeps translated plural variants and prunes keys the base dropped", () => {
		const report = createReport();
		const merged = mergeNamespace(
			{ gone: "x", nested: { count_few: "{{count}} feedy" } },
			{},
			base,
			report,
		) as { gone?: string; nested: Record<string, string> };
		expect(merged.gone).toBeUndefined();
		expect(merged.nested.count_few).toBe("{{count}} feedy");
		expect(report.pruned).toEqual(["gone"]);
	});
});

describe("serializeLocale", () => {
	it("uses tabs and a trailing newline", () => {
		expect(serializeLocale({ a: "b" })).toBe('{\n\t"a": "b"\n}\n');
	});
});
