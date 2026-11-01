import { isObject } from "@sapphire/utilities";
import { XMLParser } from "fast-xml-parser";

export interface FeedEntry {
	id: string;
	url: string;
	title: string | null;
	text: string | null;
	authorName: string | null;
	imageUrl: string | null;
	publishedAt: Date | null;
}

export interface ParsedFeed {
	title: string | null;
	/** Newest first. */
	entries: FeedEntry[];
}

/** More than any feed needs between two checks, and it bounds what one source can cost. */
export const MaximumFeedEntries = 50;

const MaximumCodePoint = 1_114_111;
const MaximumXhtmlDepth = 16;
const HiddenBlockMarkers = /<!--|-->|<\/?(?:script|style)\b[^<>]*>/gi;
const ListTags = new Set(["item", "entry", "link", "author", "media:content"]);
const NamedEntities: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
};

// `processEntities` is off so a DOCTYPE cannot define entities that expand into a memory bomb. The
// five XML entities and numeric references are decoded by `decodeEntities` instead.
const parser = new XMLParser({
	attributeNamePrefix: "@_",
	ignoreAttributes: false,
	isArray: (name) => ListTags.has(name),
	parseAttributeValue: false,
	parseTagValue: false,
	processEntities: false,
	// Atom is usually the default namespace, but a valid feed can spell every tag `atom:title`. The
	// other prefixes stay, since `media:content` and Atom's own `content` are different things.
	transformTagName: (name) => name.replace(/^atom:/, ""),
	trimValues: true,
});

/**
 * Reads an RSS 2.0, RSS 1.0 or Atom document into one shape, answering `null` for anything else.
 * Parsing is lenient on purpose: plenty of live feeds are not well-formed XML.
 */
export function parseFeed(xml: string): ParsedFeed | null {
	const document = parseDocument(xml);
	if (document === null) return null;

	const rss = (document.rss ?? document["rdf:RDF"]) as FeedNode | undefined;
	if (isObject(rss)) {
		const channel = (rss.channel ?? {}) as FeedNode;
		const items = (channel.item ?? rss.item ?? []) as FeedNode[];
		return buildFeed(channel.title, items);
	}

	const atom = document.feed as FeedNode | undefined;
	if (isObject(atom)) {
		return buildFeed(atom.title, (atom.entry ?? []) as FeedNode[]);
	}

	return null;
}

/** Finds the feed a web page advertises, so a member can paste the site instead of the feed. */
export function findFeedLink(html: string, baseUrl: string): string | null {
	for (const [tag] of html.matchAll(/<link\b[^<>]*>/gi)) {
		const rel = readAttribute(tag, "rel")?.toLowerCase();
		const type = readAttribute(tag, "type")?.toLowerCase();
		const href = decodeEntities(readAttribute(tag, "href") ?? "");
		if (
			rel?.split(/\s+/).includes("alternate") &&
			(type === "application/rss+xml" || type === "application/atom+xml") &&
			href &&
			URL.canParse(href, baseUrl)
		) {
			return new URL(href, baseUrl).href;
		}
	}

	return null;
}

/** Turns the HTML of a post into plain text. Entities are decoded twice because feeds nest them. */
export function htmlToText(html: string) {
	const text = removeHiddenBlocks(decodeEntities(html))
		.replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6])>/gi, "\n")
		// The letter after `<` keeps prose such as `1 < 2 and 3 > 2` from reading as a tag.
		.replace(/<\/?[a-z][^<>]*>/gi, " ");

	return decodeEntities(text)
		.replace(/[^\S\n]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

type FeedNode = Record<string, unknown>;

/**
 * Drops comments, scripts and styles, as a browser would, including an unclosed one. This is a
 * single pass on purpose: the feed is hostile input, and the obvious `<!--[\s\S]*?-->` rescans the
 * rest of the document for every opening marker, which froze the bot for seconds on 400 KB.
 */
function removeHiddenBlocks(html: string) {
	const kept: string[] = [];
	let cursor = 0;
	let closing: string | null = null;

	for (const { 0: marker, index } of html.matchAll(HiddenBlockMarkers)) {
		const token = marker.toLowerCase();
		if (closing === null) {
			if (token === "-->" || token.startsWith("</")) continue;

			kept.push(html.slice(cursor, index));
			closing = getClosingMarker(token);
		} else if (token.startsWith(closing)) {
			cursor = index + marker.length;
			closing = null;
		}
	}

	if (closing === null) kept.push(html.slice(cursor));
	return kept.join(" ");
}

function getClosingMarker(opening: string) {
	if (opening === "<!--") return "-->";
	return opening.startsWith("<style") ? "</style" : "</script";
}

function parseDocument(xml: string) {
	try {
		return parser.parse(xml) as FeedNode;
	} catch {
		// The input is whatever a remote server sent; not being XML just means it is not a feed.
		return null;
	}
}

function buildFeed(title: unknown, nodes: FeedNode[]): ParsedFeed {
	const entries = nodes
		.map(toEntry)
		.filter((entry): entry is FeedEntry => entry !== null);

	// Most feeds are newest first already, but the format does not promise it. Undated entries
	// have nothing to compare, so they stay in document order.
	const newestFirst = entries.every((entry) => entry.publishedAt)
		? entries.toSorted(
				(a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime(),
			)
		: entries;

	const name = readText(title);
	return {
		title: name === null ? null : htmlToText(name),
		entries: newestFirst.slice(0, MaximumFeedEntries),
	};
}

function toEntry(node: FeedNode): FeedEntry | null {
	const url = readLink(node.link) ?? readGuidUrl(node.guid);
	const id = readText(node.guid) ?? readText(node.id) ?? url;
	if (!url || !id) return null;

	const media = node["media:group"] as FeedNode | undefined;
	const html =
		readText(node["content:encoded"]) ??
		readRichText(node.content) ??
		readText(node.description) ??
		readRichText(node.summary) ??
		readText(media?.["media:description"]);

	const title = readText(node.title);
	return {
		id,
		url,
		title: title === null ? null : htmlToText(title),
		text: html === null ? null : htmlToText(html),
		authorName: readAuthor(node),
		imageUrl: readImage(node, media, html),
		publishedAt: readDate(
			node.published ?? node.pubDate ?? node["dc:date"] ?? node.updated,
		),
	};
}

function readText(value: unknown): string | null {
	if (Array.isArray(value)) return readText(value[0]);

	const text = isObject(value) ? (value as FeedNode)["#text"] : value;
	if (typeof text !== "string" && typeof text !== "number") return null;

	// XML cannot carry a NUL byte, but this parser is lenient and Postgres refuses to store one.
	const trimmed = String(text).replaceAll("\0", "").trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Atom's `type="xhtml"` nests real elements, where every other format has one string. */
function readRichText(value: unknown): string | null {
	const text = readText(value);
	if (text !== null || !isObject(value)) return text;

	const collected = collectText(value, MaximumXhtmlDepth).join(" ").trim();
	return collected.length > 0 ? collected : null;
}

function collectText(node: unknown, depth: number): string[] {
	if (typeof node === "string") return [node];
	if (depth === 0) return [];
	if (Array.isArray(node)) {
		return node.flatMap((entry) => collectText(entry, depth - 1));
	}
	if (!isObject(node)) return [];

	return Object.entries(node)
		.filter(([key]) => !key.startsWith("@_"))
		.flatMap(([, value]) => collectText(value, depth - 1));
}

function readLink(value: unknown): string | null {
	const links = Array.isArray(value) ? value : [value];
	const atomLink = links.find(
		(link): link is FeedNode =>
			isObject(link) &&
			typeof (link as FeedNode)["@_href"] === "string" &&
			[undefined, "alternate"].includes((link as FeedNode)["@_rel"] as string),
	);
	if (atomLink) return decodeEntities(atomLink["@_href"] as string);

	const text = readText(links.find((link) => !isObject(link)));
	return text === null ? null : decodeEntities(text);
}

/** An RSS `guid` is a URL unless `isPermaLink="false"` says otherwise. */
function readGuidUrl(value: unknown) {
	if (isObject(value) && (value as FeedNode)["@_isPermaLink"] === "false") {
		return null;
	}

	const text = readText(value);
	return text !== null && URL.canParse(text) ? text : null;
}

function readAuthor(node: FeedNode) {
	const author = Array.isArray(node.author) ? node.author[0] : node.author;
	const name = isObject(author)
		? readText((author as FeedNode).name)
		: readText(author);
	const value = name ?? readText(node["dc:creator"]);
	return value === null ? null : htmlToText(value);
}

function readImage(
	node: FeedNode,
	media: FeedNode | undefined,
	html: string | null,
) {
	const declared = [
		node["media:thumbnail"],
		media?.["media:thumbnail"],
		node["media:content"],
		node.enclosure,
	]
		.flat()
		.find(
			(entry): entry is FeedNode =>
				isObject(entry) &&
				typeof (entry as FeedNode)["@_url"] === "string" &&
				isImageNode(entry as FeedNode),
		);
	if (declared) return decodeEntities(declared["@_url"] as string);

	return readInlineImage(decodeEntities(html ?? ""));
}

function readInlineImage(html: string) {
	for (const [tag] of html.matchAll(/<img\s[^<>]*>/gi)) {
		const source = readAttribute(tag, "src");
		if (source) return decodeEntities(source);
	}

	return null;
}

function isImageNode(node: FeedNode) {
	const type = node["@_type"];
	return (
		type === undefined ||
		String(type).startsWith("image/") ||
		node["@_medium"] === "image"
	);
}

function readDate(value: unknown) {
	const text = readText(value);
	if (text === null) return null;

	const date = new Date(text);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Reads an HTML attribute. Minified pages drop the quotes, so all three spellings are allowed. */
function readAttribute(tag: string, name: string) {
	const expression = new RegExp(
		`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
		"i",
	);
	const match = expression.exec(tag);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function decodeEntities(text: string) {
	return text.replace(
		/&(#x[\da-f]+|#\d+|[a-z]+);/gi,
		(entity, body: string) => {
			if (!body.startsWith("#")) {
				return NamedEntities[body.toLowerCase()] ?? entity;
			}

			const code =
				body[1].toLowerCase() === "x"
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			return code > 0 && code <= MaximumCodePoint
				? String.fromCodePoint(code)
				: entity;
		},
	);
}
