import { readFileSync } from "node:fs";
import { findFeedLink, htmlToText, parseFeed } from "#social/feed";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
	readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

describe("parseFeed", () => {
	it("reads an RSS 2.0 feed, newest first", () => {
		const feed = parseFeed(read("rss.xml"))!;

		expect(feed.title).toBe("Example & Friends");
		expect(feed.entries.map((entry) => entry.id)).toEqual([
			"https://example.com/newer",
			"older-guid",
		]);
		expect(feed.entries[0]).toMatchObject({
			url: "https://example.com/newer",
			title: "Newer post",
			text: "First line.\n1 < 2 and 3 > 2",
			authorName: "Alice",
			imageUrl: "https://example.com/cover.jpg",
			publishedAt: new Date("2026-10-31T10:00:00Z"),
		});
	});

	it("turns the HTML of an entry into text and finds an inline picture", () => {
		const older = parseFeed(read("rss.xml"))!.entries[1];

		expect(older).toMatchObject({
			title: "Older post",
			text: "Hello & welcome",
			imageUrl: "https://example.com/inline.png",
		});
	});

	it("drops an entry with nothing to link to", () => {
		expect(parseFeed(read("rss.xml"))!.entries).toHaveLength(2);
	});

	it("reads an Atom feed, picking the alternate link", () => {
		const feed = parseFeed(read("atom.xml"))!;

		expect(feed.title).toBe("Atom Example");
		expect(feed.entries[0]).toMatchObject({
			id: "tag:example.org,2026:1",
			url: "https://example.org/1",
			title: "An Atom entry",
			text: "A description",
			authorName: "Bob",
			imageUrl: "https://example.org/thumb.jpg",
			publishedAt: new Date("2026-10-29T20:00:20Z"),
		});
	});

	it("reads an Atom feed that spells out its namespace prefix", () => {
		const feed = parseFeed(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
			<atom:title>Prefixed</atom:title>
			<atom:entry>
				<atom:id>1</atom:id>
				<atom:title>One</atom:title>
				<atom:link href="https://example.net/1"/>
			</atom:entry>
		</atom:feed>`)!;

		expect(feed.title).toBe("Prefixed");
		expect(feed.entries[0]).toMatchObject({
			id: "1",
			title: "One",
			url: "https://example.net/1",
		});
	});

	it("keeps Atom's content apart from the media namespace", () => {
		const feed =
			parseFeed(`<feed><entry><id>1</id><link href="https://a.example/1"/>
			<content>Body</content><media:content url="https://a.example/1.png" medium="image"/>
		</entry></feed>`)!;

		expect(feed.entries[0]).toMatchObject({
			text: "Body",
			imageUrl: "https://a.example/1.png",
		});
	});

	it("reads the nested text of Atom's xhtml content", () => {
		const feed =
			parseFeed(`<feed><entry><id>1</id><link href="https://a.example/1"/>
			<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello</p></div></content>
		</entry></feed>`)!;

		expect(feed.entries[0].text).toBe("Hello");
	});

	it("reads an RSS 1.0 document, whose items sit beside the channel", () => {
		const feed = parseFeed(`<rdf:RDF xmlns:rdf="x">
			<channel><title>RDF</title></channel>
			<item><title>One</title><link>https://example.net/1</link></item>
		</rdf:RDF>`)!;

		expect(feed.entries.map((entry) => entry.url)).toEqual([
			"https://example.net/1",
		]);
	});

	it("keeps document order when an entry has no date", () => {
		const feed = parseFeed(`<rss><channel>
			<item><link>https://example.net/a</link></item>
			<item><link>https://example.net/b</link><pubDate>2026-10-31</pubDate></item>
		</channel></rss>`)!;

		expect(feed.entries.map((entry) => entry.url)).toEqual([
			"https://example.net/a",
			"https://example.net/b",
		]);
	});

	it("caps how many entries one feed can hand over", () => {
		const items = Array.from(
			{ length: 80 },
			(_, index) => `<item><link>https://example.net/${index}</link></item>`,
		);

		const feed = parseFeed(`<rss><channel>${items.join("")}</channel></rss>`)!;

		expect(feed.entries).toHaveLength(50);
	});

	it.each(["", "<html><body>Hello</body></html>", "not xml at all", "{}"])(
		"refuses %j",
		(input) => {
			expect(parseFeed(input)).toBeNull();
		},
	);

	it("does not expand entities a document defines for itself", () => {
		const bomb = `<?xml version="1.0"?>
			<!DOCTYPE rss [
				<!ENTITY a "aaaaaaaaaa">
				<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
				<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
			]>
			<rss><channel><title>&c;</title></channel></rss>`;

		expect(parseFeed(bomb)?.title ?? "").not.toContain("aaaaaaaaaa");
	});
});

describe("hostile input", () => {
	const Size = 2 * 1024 * 1024;
	const inFeed = (html: string) =>
		`<rss><channel><item><link>https://a.example/</link><description><![CDATA[${html}]]></description></item></channel></rss>`;

	/** Each of these took minutes at this size when the scans were quadratic. */
	it.each([
		[
			"repeated link tags",
			() => findFeedLink("<link ".repeat(Size / 6), "https://a.example/"),
		],
		["repeated script tags", () => htmlToText("<script>".repeat(Size / 8))],
		["repeated comments", () => htmlToText("<!--".repeat(Size / 4))],
		["repeated image tags", () => parseFeed(inFeed("<img ".repeat(Size / 5)))],
		["a tag that never closes", () => htmlToText(`<a ${"b".repeat(Size)}`)],
		["an entity that never ends", () => htmlToText(`&${"a".repeat(Size)}`)],
	])("gets through %s in linear time", (_, run) => {
		const start = performance.now();

		run();

		expect(performance.now() - start).toBeLessThan(2000);
	});

	it("does not throw on an entity that decodes into a broken URL", () => {
		const tag = `<link rel="alternate" type="application/rss+xml" href="&#104;ttps://[">`;

		expect(findFeedLink(tag, "https://a.example/")).toBeNull();
	});

	it("strips NUL bytes, which Postgres cannot store", () => {
		const feed = parseFeed(
			"<rss><channel><title>a\0b</title><item><guid>x\0y</guid><link>https://a.example/</link></item></channel></rss>",
		)!;

		expect(feed.title).toBe("ab");
		expect(feed.entries[0].id).toBe("xy");
	});
});

describe("findFeedLink", () => {
	const page = (tag: string) => `<html><head>${tag}</head></html>`;

	it("resolves an advertised feed against the page", () => {
		const html = page(
			`<link rel="alternate" type="application/rss+xml" href="/feed.xml">`,
		);

		expect(findFeedLink(html, "https://example.com/blog/")).toBe(
			"https://example.com/feed.xml",
		);
	});

	it("accepts Atom and attributes in any order", () => {
		const html = page(
			`<link href='https://example.com/atom' type='application/atom+xml' rel='alternate'>`,
		);

		expect(findFeedLink(html, "https://example.com/")).toBe(
			"https://example.com/atom",
		);
	});

	it("reads the unquoted attributes of a minified page", () => {
		const html = page(
			"<link rel=alternate type=application/rss+xml href=/feed.xml>",
		);

		expect(findFeedLink(html, "https://example.com/")).toBe(
			"https://example.com/feed.xml",
		);
	});

	it("allows spaces around the equals sign and an apostrophe in a URL", () => {
		const html = page(
			`<link rel = "alternate" type = "application/rss+xml" href = "/it's/feed.xml">`,
		);

		expect(findFeedLink(html, "https://example.com/")).toBe(
			"https://example.com/it's/feed.xml",
		);
	});

	it.each([
		`<link rel="stylesheet" href="/a.css">`,
		`<link rel="alternate" type="text/html" href="/fr">`,
		`<link rel="alternate" type="application/rss+xml">`,
	])("ignores %s", (tag) => {
		expect(findFeedLink(page(tag), "https://example.com/")).toBeNull();
	});
});

describe("htmlToText", () => {
	it.each([
		["<p>a</p><p>b</p>", "a\nb"],
		["a<br/>b", "a\nb"],
		["&lt;b&gt;bold&lt;/b&gt;", "bold"],
		["&amp;amp;", "&"],
		["&#65;&#x42;", "AB"],
		["&#xFFFFFFFF;", "&#xFFFFFFFF;"],
		["<style>p{}</style>text", "text"],
		["<!-- hidden -->text", "text"],
		["<SCRIPT>x</SCRIPT>text", "text"],
		['<style media="print">x</style>text', "text"],
		["<script>x</style>y</script>text", "text"],
		["before<!-- never closed", "before"],
		["before<script>never closed", "before"],
		["a-->b", "a-->b"],
		["1 < 2 and 3 > 2", "1 < 2 and 3 > 2"],
		["  spaced   out  ", "spaced out"],
	])("reads %j as %j", (html, text) => {
		expect(htmlToText(html)).toBe(text);
	});
});
