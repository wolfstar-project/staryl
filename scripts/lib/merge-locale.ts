/**
 * Pure helpers that fold a pulled Tolgee namespace onto the committed locale file.
 * Kept free of file access so tests/scripts/merge-locale.test.ts can cover them.
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface MergeReport {
	/** Translations applied. */
	updated: string[];
	/** Translations rejected (placeholders differ from the base, or invalid command name). */
	rejected: { path: string; expected: string; got: string }[];
	/** Local keys the base no longer defines. */
	pruned: string[];
}

const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/;
const COMMAND_NAME_KEY = /(?:^|[a-z])Name$|^name$/;
const BASE_COMMAND_NAME = /^[a-z0-9_-]{1,32}$/;
const VALID_COMMAND_NAME = /^[\p{L}\p{N}_-]{1,32}$/u;

export function createReport(): MergeReport {
	return { updated: [], rejected: [], pruned: [] };
}

function isObject(
	value: JsonValue | undefined,
): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{{name}}` / `{{value, orList}}` → the sorted placeholder names. */
export function placeholders(value: string): string {
	const names = [...value.matchAll(/\{\{\s*([^,}\s]+)/g)].map(
		(match) => match[1],
	);
	return [...new Set(names)].toSorted().join(",");
}

function isUsable(value: JsonValue | undefined): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/** The base value a translated plural variant (`key_few`) is compared against. */
function baseFor(
	base: { [key: string]: JsonValue },
	key: string,
): JsonValue | undefined {
	if (key in base) return base[key];
	const stem = key.replace(PLURAL_SUFFIX, "");
	if (stem === key) return undefined;
	return base[`${stem}_other`] ?? base[`${stem}_one`];
}

function acceptString(
	key: string,
	path: string,
	pulled: string,
	base: JsonValue | undefined,
	report: MergeReport,
): string | undefined {
	if (!isUsable(pulled)) return undefined;
	let value = pulled;
	if (typeof base === "string") {
		if (COMMAND_NAME_KEY.test(key) && BASE_COMMAND_NAME.test(base)) {
			value = value.trim().toLowerCase();
			if (!VALID_COMMAND_NAME.test(value)) {
				report.rejected.push({ path, expected: base, got: pulled });
				return undefined;
			}
		}
		if (placeholders(base) !== placeholders(value)) {
			report.rejected.push({ path, expected: base, got: pulled });
			return undefined;
		}
	}
	return value;
}

/**
 * Merge `pulled` onto `local`, using `base` (en-US) as the reference for the shape.
 * Key order of `local` is preserved, new keys follow base order, keys the base no
 * longer defines are dropped (plural variants of a base key are kept).
 */
export function mergeNamespace(
	local: JsonValue | undefined,
	pulled: JsonValue | undefined,
	base: JsonValue | undefined,
	report: MergeReport,
	path = "",
): JsonValue {
	if (!isObject(base)) return local ?? "";

	const localObj = isObject(local) ? local : {};
	const pulledObj = isObject(pulled) ? pulled : {};
	const ordered = [
		...Object.keys(localObj),
		...Object.keys(base).filter((key) => !(key in localObj)),
		// Translated plural variants (`key_few`) that only exist outside the base
		...Object.keys(pulledObj).filter(
			(key) => !(key in localObj) && !(key in base),
		),
	];

	const result: { [key: string]: JsonValue } = {};
	for (const key of ordered) {
		const keyPath = path ? `${path}.${key}` : key;
		const baseValue = baseFor(base, key);
		if (baseValue === undefined) {
			if (key in localObj) report.pruned.push(keyPath);
			continue;
		}

		const localValue = localObj[key];
		const pulledValue = pulledObj[key];

		if (isObject(baseValue)) {
			result[key] = mergeNamespace(
				localValue,
				pulledValue,
				baseValue,
				report,
				keyPath,
			);
		} else if (Array.isArray(baseValue)) {
			result[key] = mergeArray(
				key,
				keyPath,
				localValue,
				pulledValue,
				baseValue,
				report,
			);
		} else {
			const accepted =
				typeof pulledValue === "string"
					? acceptString(key, keyPath, pulledValue, baseValue, report)
					: undefined;
			if (accepted !== undefined) {
				if (accepted !== localValue) report.updated.push(keyPath);
				result[key] = accepted;
			} else {
				result[key] = localValue ?? "";
			}
		}
	}
	return result;
}

function mergeArray(
	key: string,
	path: string,
	local: JsonValue | undefined,
	pulled: JsonValue | undefined,
	base: JsonValue[],
	report: MergeReport,
): JsonValue {
	const fallback = Array.isArray(local) ? local : base.map(() => "");
	if (!Array.isArray(pulled) || pulled.length !== base.length) return fallback;

	const accepted = pulled.map((item, index) =>
		typeof item === "string"
			? acceptString(key, `${path}[${index}]`, item, base[index], report)
			: undefined,
	);
	// An array is applied as a whole: a half-translated list would misalign with en-US.
	if (accepted.some((item) => item === undefined)) return fallback;
	if (JSON.stringify(accepted) !== JSON.stringify(local))
		report.updated.push(path);
	return accepted as string[];
}

/** Count the leaf strings of a merged tree that carry a translation. */
export function countTranslations(value: JsonValue): number {
	if (typeof value === "string") return value.trim() === "" ? 0 : 1;
	if (Array.isArray(value))
		return value.reduce<number>(
			(total, item) => total + countTranslations(item),
			0,
		);
	if (isObject(value))
		return Object.values(value).reduce<number>(
			(total, item) => total + countTranslations(item),
			0,
		);
	return 0;
}

/** Repository style: tabs and a trailing newline. */
export function serializeLocale(value: JsonValue): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}
