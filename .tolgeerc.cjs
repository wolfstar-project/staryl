/**
 * Tolgee CLI config for Staryl.
 *
 * Local layout: src/locales/{discordLocale}/{namespace}.json
 * Tolgee tags differ from some Discord directories (es-ES → es, zh-CN → zh-Hans, …).
 *
 * No `projectId` here: a Project API Key already identifies the project. Set
 * TOLGEE_API_KEY (Project API Key or PAT) in the environment, never commit it. With a
 * PAT, add `projectId` or pass `--project-id`.
 *
 * Push uses an explicit files list so local folder names ≠ Tolgee tags. Pull stages
 * into `.tolgee-pull/`; `pnpm tolgee:pull` remaps via scripts/tolgee-pull-remap.ts
 * using `tolgeeToLocal` below.
 *
 * en-US is push-only: it is the local source of truth for every string, so the remap
 * step never writes src/locales/en-US, no matter what the export contains.
 * Default script pushes base English only (`pnpm tolgee:push` → `--languages en-US`).
 */
const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

/** Local directory under src/locales/ → Tolgee language tag. */
const LOCALE_MAP = {
	"en-US": "en-US",
	"en-GB": "en-GB",
	"es-ES": "es",
	"es-419": "es-419",
	bg: "bg",
	cs: "cs",
	da: "da",
	de: "de",
	el: "el",
	fi: "fi",
	fr: "fr",
	hi: "hi",
	hr: "hr",
	hu: "hu",
	id: "id",
	it: "it",
	ja: "ja",
	ko: "ko",
	lt: "lt",
	nl: "nl",
	no: "no",
	pl: "pl",
	"pt-BR": "pt",
	ro: "ro",
	ru: "ru",
	"sv-SE": "sv",
	th: "th",
	tr: "tr",
	uk: "uk",
	vi: "vi",
	"zh-CN": "zh-Hans",
	"zh-TW": "zh-Hant",
};

/** Tolgee language tag → local directory (for pull remapping). */
const TOLGEE_TO_LOCAL = Object.fromEntries(
	Object.entries(LOCALE_MAP).map(([local, tag]) => [tag, local]),
);

/** Collect namespace-relative paths (e.g. globals, commands/social). */
function collectNamespaces(dir, relative = "") {
	const namespaces = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			namespaces.push(...collectNamespaces(join(dir, entry.name), rel));
		} else if (entry.isFile() && entry.name.endsWith(".json")) {
			namespaces.push(rel.replace(/\.json$/, ""));
		}
	}
	return namespaces;
}

const localesRoot = join(__dirname, "src/locales");
if (!existsSync(join(localesRoot, "en-US"))) {
	throw new Error(
		`Missing base locale directory: ${join(localesRoot, "en-US")}`,
	);
}

// Union across all configured locales: a namespace may exist outside en-US only.
const NAMESPACES = [
	...new Set(
		Object.keys(LOCALE_MAP).flatMap((localDir) => {
			const dir = join(localesRoot, localDir);
			return existsSync(dir) ? collectNamespaces(dir) : [];
		}),
	),
].toSorted();

// Explicit path → Tolgee language/namespace. Skip missing files: locales other than
// en-US only exist once they have been pulled.
const pushFiles = Object.entries(LOCALE_MAP).flatMap(([localDir, language]) =>
	NAMESPACES.flatMap((namespace) => {
		if (!existsSync(join(localesRoot, localDir, `${namespace}.json`)))
			return [];
		return [
			{
				path: `./src/locales/${localDir}/${namespace}.json`,
				language,
				namespace,
			},
		];
	}),
);

module.exports = {
	$schema:
		"https://raw.githubusercontent.com/tolgee/tolgee-cli/main/schema.json",
	format: "JSON_I18NEXT",
	push: {
		forceMode: "KEEP",
		files: pushFiles,
	},
	pull: {
		path: ".tolgee-pull",
		fileStructureTemplate: "{languageTag}/{namespace}.json",
		// Rebuild `name[0]` keys into real arrays (e.g. commands/twitch `statusValues`).
		supportArrays: true,
		// Everything except UNTRANSLATED, which is exported as `null` and must never
		// reach a locale file. A key with no translation keeps what the repository has
		// because the remap script merges the export onto the committed files.
		states: ["TRANSLATED", "REVIEWED"],
		// Clear staging before every pull so leftovers from an interrupted pull cannot
		// be promoted over live locales by the remapper.
		emptyDir: true,
	},
	// Exported for scripts/tolgee-pull-remap.ts (single source of truth with push)
	tolgeeToLocal: TOLGEE_TO_LOCAL,
	localeMap: LOCALE_MAP,
	namespaces: NAMESPACES,
};
