import type { PublicFetcher, PublicResponse } from "#social/publicFetch";
import { readFileSync } from "node:fs";
import { createRssProvider } from "#social/providers/rss";
import { err, ok } from "@sapphire/result";
import { describe, expect, it, vi } from "vitest";

const Rss = readFileSync(
	new URL("../../fixtures/rss.xml", import.meta.url),
	"utf8",
);
const FeedUrl = "https://example.com/feed.xml";

function respond(overrides: Partial<PublicResponse> = {}): PublicResponse {
	return { status: 200, url: FeedUrl, headers: {}, body: Rss, ...overrides };
}

function makeProvider(...answers: Awaited<ReturnType<PublicFetcher>>[]) {
	const fetchUrl = vi.fn<PublicFetcher>();
	for (const answer of answers) fetchUrl.mockResolvedValueOnce(answer);
	return { provider: createRssProvider(fetchUrl), fetchUrl };
}

describe("validateTarget", () => {
	it("accepts a feed URL and names the source after the feed", async () => {
		const { provider } = makeProvider(ok(respond()));

		const result = await provider.validateTarget(FeedUrl);

		expect(result.unwrap()).toEqual({
			target: FeedUrl,
			displayName: "Example & Friends",
		});
	});

	it("adds https to a URL typed without a scheme", async () => {
		const { provider, fetchUrl } = makeProvider(ok(respond()));

		await provider.validateTarget("example.com/feed.xml");

		expect(fetchUrl.mock.calls[0][0]).toBe(FeedUrl);
	});

	it("uses the URL a redirect ended at, so one feed is one source", async () => {
		const { provider } = makeProvider(
			ok(respond({ url: "https://new.example.com/feed.xml" })),
		);

		const result = await provider.validateTarget(FeedUrl);

		expect(result.unwrap().target).toBe("https://new.example.com/feed.xml");
	});

	it("finds the feed a site advertises", async () => {
		const page = `<html><link rel="alternate" type="application/rss+xml" href="/feed.xml"></html>`;
		const { provider, fetchUrl } = makeProvider(
			ok(respond({ url: "https://example.com/", body: page })),
			ok(respond()),
		);

		const result = await provider.validateTarget("https://example.com/");

		expect(fetchUrl.mock.calls[1][0]).toBe(FeedUrl);
		expect(result.unwrap().target).toBe(FeedUrl);
	});

	it.each([
		[
			"a page with no feed",
			ok(respond({ body: "<html></html>" })),
			"TargetUnsupported",
		],
		["a missing page", ok(respond({ status: 404 })), "TargetNotFound"],
		["a server error", ok(respond({ status: 500 })), "TargetUnreachable"],
		["a private address", err({ _tag: "ForbiddenAddress" }), "TargetBlocked"],
		["a malformed URL", err({ _tag: "InvalidUrl" }), "InvalidTarget"],
		["a timeout", err({ _tag: "Timeout" }), "TargetUnreachable"],
		["a huge document", err({ _tag: "TooLarge" }), "TargetUnsupported"],
	] as const)("explains %s", async (_, answer, tag) => {
		const { provider } = makeProvider(answer as never);

		const result = await provider.validateTarget(FeedUrl);

		expect(result.unwrapErr()).toEqual({ _tag: tag });
	});
});

describe("fetchLatest", () => {
	it("normalizes the entries and keeps what a conditional request needs", async () => {
		const { provider } = makeProvider(
			ok(
				respond({
					headers: { etag: '"v2"', "last-modified": "yesterday" },
				}),
			),
		);

		const result = await provider.fetchLatest(FeedUrl, null);

		expect(result.unwrap()).toMatchObject({
			_tag: "Items",
			items: [
				{ id: "https://example.com/newer", authorAvatarUrl: null },
				{ id: "older-guid" },
			],
			state: { etag: '"v2"', lastModified: "yesterday" },
		});
	});

	it("resolves links relative to the feed", async () => {
		const body = `<rss><channel><item><link>/posts/1</link><enclosure url="/1.png"/></item></channel></rss>`;
		const { provider } = makeProvider(ok(respond({ body })));

		const result = await provider.fetchLatest(FeedUrl, null);

		expect(result.unwrap()).toMatchObject({
			items: [
				{
					url: "https://example.com/posts/1",
					imageUrl: "https://example.com/1.png",
				},
			],
		});
	});

	it("resolves an Atom link relative to the feed", async () => {
		const body = `<feed><entry><id>1</id><link href="/posts/1"/></entry></feed>`;
		const { provider } = makeProvider(ok(respond({ body })));

		const result = await provider.fetchLatest(FeedUrl, null);

		expect(result.unwrap()).toMatchObject({
			items: [{ url: "https://example.com/posts/1" }],
		});
	});

	it("drops an entry whose link is not a web URL", async () => {
		const body = `<rss><channel><item><link>javascript:alert(1)</link><guid>x</guid></item></channel></rss>`;
		const { provider } = makeProvider(ok(respond({ body })));

		const result = await provider.fetchLatest(FeedUrl, null);

		expect(result.unwrap()).toMatchObject({ items: [] });
	});

	it("drops a picture that is not https", async () => {
		const body = `<rss><channel><item><link>https://a.example/1</link><enclosure url="http://a.example/1.png"/></item></channel></rss>`;
		const { provider } = makeProvider(ok(respond({ body })));

		const result = await provider.fetchLatest(FeedUrl, null);

		expect(result.unwrap()).toMatchObject({ items: [{ imageUrl: null }] });
	});

	it("sends back what the server said last time", async () => {
		const { provider, fetchUrl } = makeProvider(ok(respond({ status: 304 })));

		const result = await provider.fetchLatest(FeedUrl, {
			etag: '"v1"',
			lastModified: "yesterday",
		});

		expect(fetchUrl.mock.calls[0][1]?.headers).toMatchObject({
			"if-none-match": '"v1"',
			"if-modified-since": "yesterday",
		});
		expect(result.unwrap()).toEqual({ _tag: "NotModified" });
	});

	it.each([
		["a 404", ok(respond({ status: 404 })), { _tag: "TargetUnavailable" }],
		["a 410", ok(respond({ status: 410 })), { _tag: "TargetUnavailable" }],
		[
			"a login wall",
			ok(respond({ status: 401 })),
			{ _tag: "TargetUnavailable" },
		],
		["a 500", ok(respond({ status: 500 })), { _tag: "Unavailable" }],
		[
			"a rate limit",
			ok(respond({ status: 429, headers: { "retry-after": "60" } })),
			{ _tag: "RateLimited", retryAfterMs: 60_000 },
		],
		[
			"a garbled body",
			ok(respond({ body: "nope" })),
			{ _tag: "InvalidResponse" },
		],
		["a timeout", err({ _tag: "Timeout" }), { _tag: "Unavailable" }],
		[
			"a host that moved to a private address",
			err({ _tag: "ForbiddenAddress" }),
			{ _tag: "TargetUnavailable" },
		],
	] as const)("reports %s", async (_, answer, failure) => {
		const { provider } = makeProvider(answer as never);

		const result = await provider.fetchLatest(FeedUrl, null);

		expect(result.unwrapErr()).toEqual(failure);
	});
});

describe("rateLimitScope", () => {
	it("shares one budget per remote host", () => {
		const { provider } = makeProvider();

		expect(provider.rateLimitScope("https://a.example/x")).toBe(
			provider.rateLimitScope("https://a.example/y"),
		);
		expect(provider.rateLimitScope("https://a.example/x")).not.toBe(
			provider.rateLimitScope("https://b.example/x"),
		);
	});
});

describe("insertion validation", () => {
	it.each([
		'<rss version="2.0"><channel><title>Broken</title>',
		"<feed><entry></feed>",
		"<html><body>Not a feed</body></html>",
	])("rejects invalid XML or an unknown document: %s", async (body) => {
		const { provider } = makeProvider(ok(respond({ body })));
		expect((await provider.validateTarget(FeedUrl)).unwrapErr()).toEqual({
			_tag: "TargetUnsupported",
		});
	});
	it("discovers and validates an Atom feed from a website", async () => {
		const { provider, fetchUrl } = makeProvider(
			ok(
				respond({
					url: "https://example.com/",
					body: '<html><head><link href="/atom.xml" type="application/atom+xml" rel="alternate"></head></html>',
				}),
			),
			ok(
				respond({
					url: "https://example.com/atom.xml",
					body: '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title></feed>',
				}),
			),
		);
		expect(
			(await provider.validateTarget("https://example.com/")).unwrap(),
		).toEqual({ target: "https://example.com/atom.xml", displayName: "Atom" });
		expect(fetchUrl.mock.calls[1][0]).toBe("https://example.com/atom.xml");
	});
});
