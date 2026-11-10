import type { JsonValue, MergeReport } from "./lib/merge-locale.ts";
/**
 * Fold a Tolgee export into the Staryl locale directories.
 *
 * Reads .tolgee-pull/{tag}/{namespace}.json → src/locales/{locale}/{namespace}.json
 *
 * Tolgee tags (es, pt, zh-Hans, …) are remapped to Discord locale folder names
 * (es-ES, pt-BR, zh-CN, …) using `tolgeeToLocal` from `.tolgeerc.cjs`. Nested
 * namespaces (commands/social, events/twitch) are preserved.
 *
 * This is a merge, not an overwrite: the committed file is the starting point and
 * only genuine translations are applied on top (see scripts/lib/merge-locale.ts).
 * src/locales/en-US is never written, it is the local source of truth.
 *
 * Usage:  pnpm tolgee:pull
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
	countTranslations,
	createReport,
	mergeNamespace,
	serializeLocale,
} from "./lib/merge-locale.ts";

const root = join(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

const config = require("../.tolgeerc.cjs") as {
	pull: { path: string };
	tolgeeToLocal: Record<string, string>;
};

const BASE_LOCALE = "en-US";
const pullRoot = join(root, config.pull.path.replace(/^\.\//, ""));
const localesRoot = join(root, "src/locales");
const reportPath = join(root, ".tolgee-report.md");

function collectJsonFiles(dir: string, relative = ""): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory())
			files.push(...collectJsonFiles(join(dir, entry.name), rel));
		else if (entry.isFile() && entry.name.endsWith(".json")) files.push(rel);
	}
	return files;
}

function readJson(path: string): JsonValue {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as JsonValue;
	} catch (error) {
		console.error(`Invalid or unreadable JSON: ${path}`);
		console.error(String(error));
		console.error(`Staging directory preserved for inspection: ${pullRoot}`);
		process.exit(1);
	}
}

if (!existsSync(pullRoot)) {
	console.error(`Missing pull directory: ${pullRoot}`);
	console.error("Run `pnpm exec tolgee pull` first.");
	process.exit(1);
}

const pullTags = readdirSync(pullRoot, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
	.map((entry) => entry.name);

// Build the full replacement set in memory before touching src/locales, so an invalid
// staging file cannot leave the live locale tree partially updated.
const writes: { dest: string; content: string }[] = [];
const reports = new Map<string, MergeReport>();
let scanned = 0;

for (const tag of pullTags) {
	const localDir =
		config.tolgeeToLocal[tag] ??
		(existsSync(join(localesRoot, tag)) ? tag : undefined);
	if (!localDir) {
		console.warn(`Skipping unmapped Tolgee language tag: ${tag}`);
		continue;
	}
	if (localDir === BASE_LOCALE) continue;

	for (const namespace of collectJsonFiles(join(pullRoot, tag))) {
		scanned++;
		const pulled = readJson(join(pullRoot, tag, namespace));
		const basePath = join(localesRoot, BASE_LOCALE, namespace);
		if (!existsSync(basePath)) {
			console.warn(
				`Skipping ${tag}/${namespace}: no ${BASE_LOCALE} namespace of that name`,
			);
			continue;
		}

		const dest = join(localesRoot, localDir, namespace);
		const local = existsSync(dest) ? readJson(dest) : undefined;
		const report = createReport();
		const merged = mergeNamespace(local, pulled, readJson(basePath), report);
		if (
			report.updated.length + report.rejected.length + report.pruned.length >
			0
		) {
			reports.set(`${localDir}/${namespace}`, report);
		}

		// Nothing translated yet: do not create a file full of empty placeholders.
		if (!local && countTranslations(merged) === 0) continue;

		const content = serializeLocale(merged);
		if (existsSync(dest) && readFileSync(dest, "utf8") === content) continue;
		writes.push({ dest, content });
	}
}

if (scanned === 0) {
	console.log(
		`Nothing to remap: the pull contains no language other than ${BASE_LOCALE}.`,
	);
	rmSync(pullRoot, { recursive: true, force: true });
	process.exit(0);
}

for (const { dest, content } of writes) {
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, content, "utf8");
}
rmSync(pullRoot, { recursive: true, force: true });

const summary = buildSummary();
writeFileSync(reportPath, summary, "utf8");
if (process.env.GITHUB_STEP_SUMMARY)
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
console.log(
	writes.length === 0
		? `Scanned ${scanned} staged locale files; no translation changes to apply.`
		: `Updated ${writes.length} of ${scanned} staged locale files in src/locales/`,
);

function buildSummary(): string {
	const lines = ["*bleep bloop* I synced the translations from Tolgee", ""];
	const updated = [...reports.values()].reduce(
		(total, report) => total + report.updated.length,
		0,
	);
	lines.push(
		`- **${updated}** translation(s) applied across **${writes.length}** file(s)`,
	);
	lines.push(
		`- \`src/locales/${BASE_LOCALE}\` untouched (source of truth, push-only)`,
	);

	const pruned = [...reports].flatMap(([ns, report]) =>
		report.pruned.map((path) => `${ns}:${path}`),
	);
	if (pruned.length > 0) {
		lines.push(
			`- **${pruned.length}** key(s) pruned (no longer defined in ${BASE_LOCALE})`,
		);
	}

	const rejected = [...reports].flatMap(([ns, report]) =>
		report.rejected.map((entry) => ({ ns, ...entry })),
	);
	if (rejected.length > 0) {
		lines.push(
			"",
			`### ⚠️ ${rejected.length} translation(s) rejected`,
			"",
			`The placeholders do not match ${BASE_LOCALE} (or the value is not a valid slash command name), so the value was left untranslated. Fix these on Tolgee:`,
			"",
			"| File | Key | Expected | Got |",
			"| --- | --- | --- | --- |",
		);
		for (const entry of rejected.slice(0, 50)) {
			lines.push(
				`| \`${entry.ns}\` | \`${entry.path}\` | \`${inline(entry.expected)}\` | \`${inline(entry.got)}\` |`,
			);
		}
		if (rejected.length > 50)
			lines.push("", `…and ${rejected.length - 50} more.`);
	}
	return `${lines.join("\n")}\n`;
}

function inline(value: string): string {
	const collapsed = value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
	return collapsed.length > 80 ? `${collapsed.slice(0, 77)}…` : collapsed;
}
