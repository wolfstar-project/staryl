import { createBlueskyProvider } from "#social/providers/bluesky";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn<typeof fetch>();
const provider = createBlueskyProvider(fetchMock);

const Did = "did:plc:z72i7hdynmk6r22z27h6tvur";
const Author = {
	did: Did,
	handle: "alice.bsky.social",
	displayName: "Alice",
	avatar: "https://cdn.bsky.app/avatar.jpg",
};
const Entry = {
	post: {
		uri: `at://${Did}/app.bsky.feed.post/3kabc`,
		author: Author,
		record: { text: "Hello", createdAt: "2026-11-01T10:00:00.000Z" },
		indexedAt: "2026-11-01T10:00:01.000Z",
		labels: [],
	},
};

function json(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), init);
}

beforeEach(() => {
	fetchMock.mockReset();
});

async function fetchItems(...entries: object[]) {
	fetchMock.mockResolvedValueOnce(json({ feed: entries }));
	const result = await provider.fetchLatest(Did, null);
	return (result.unwrap() as unknown as { items: Record<string, unknown>[] })
		.items;
}

describe("validateTarget", () => {
	it.each([
		["alice.bsky.social", "alice.bsky.social"],
		["@alice.bsky.social", "alice.bsky.social"],
		["alice", "alice.bsky.social"],
		["example.com", "example.com"],
		[Did, Did],
		["https://bsky.app/profile/alice.bsky.social", "alice.bsky.social"],
		["https://bsky.app/profile/example.com/post/3kabc", "example.com"],
	])("resolves %s to its DID", async (input, actor) => {
		fetchMock.mockResolvedValueOnce(json(Author));

		const result = await provider.validateTarget(input);

		expect(result.unwrap()).toEqual({ target: Did, displayName: "Alice" });
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			`actor=${encodeURIComponent(actor)}`,
		);
	});

	it("falls back to the handle for an account with no display name", async () => {
		fetchMock.mockResolvedValueOnce(
			json({ ...Author, displayName: undefined }),
		);

		const result = await provider.validateTarget("alice");

		expect(result.unwrap().displayName).toBe("@alice.bsky.social");
	});

	it.each(["has spaces", "bad_handle.example", "https://example.com/x"])(
		"refuses %j without calling the API",
		async (input) => {
			const result = await provider.validateTarget(input);

			expect(result.unwrapErr()).toEqual({ _tag: "InvalidTarget" });
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("treats a missing account as not found", async () => {
		fetchMock.mockResolvedValueOnce(json({}, { status: 400 }));

		const result = await provider.validateTarget("nobody.bsky.social");

		expect(result.unwrapErr()).toEqual({ _tag: "TargetNotFound" });
	});

	it("respects an account that opted out of logged-out access", async () => {
		fetchMock.mockResolvedValueOnce(
			json({ ...Author, labels: [{ val: "!no-unauthenticated" }] }),
		);

		const result = await provider.validateTarget("alice");

		expect(result.unwrapErr()).toEqual({ _tag: "TargetNotFound" });
	});

	it("does not mistake an outage for a missing account", async () => {
		fetchMock.mockResolvedValueOnce(json({}, { status: 500 }));

		const result = await provider.validateTarget("alice");

		expect(result.unwrapErr()).toEqual({ _tag: "TargetUnreachable" });
	});
});

describe("fetchLatest", () => {
	it("maps a post to its public page", async () => {
		const [item] = await fetchItems(Entry);

		expect(item).toEqual({
			id: Entry.post.uri,
			url: "https://bsky.app/profile/alice.bsky.social/post/3kabc",
			title: null,
			text: "Hello",
			authorName: "Alice",
			authorAvatarUrl: Author.avatar,
			imageUrl: null,
			publishedAt: new Date("2026-11-01T10:00:00.000Z"),
			isReply: false,
			isRepost: false,
			isNsfw: false,
		});
	});

	it("asks for everything and leaves the choosing to the filters", async () => {
		await fetchItems();

		expect(String(fetchMock.mock.calls[0][0])).toContain(
			"filter=posts_with_replies",
		);
	});

	it("flags a reply", async () => {
		const reply = {
			post: {
				...Entry.post,
				record: { ...Entry.post.record, reply: { root: {} } },
			},
		};

		const [item] = await fetchItems(reply);

		expect(item.isReply).toBe(true);
	});

	it("gives a repost its own id, dated when it was reposted", async () => {
		const repost = {
			...Entry,
			reason: {
				$type: "app.bsky.feed.defs#reasonRepost",
				indexedAt: "2026-11-02T08:00:00.000Z",
			},
		};

		const [item] = await fetchItems(repost);

		expect(item).toMatchObject({
			id: `repost:${Entry.post.uri}`,
			isRepost: true,
			publishedAt: new Date("2026-11-02T08:00:00.000Z"),
		});
	});

	it.each([
		[
			"an image post",
			{ images: [{ fullsize: "https://cdn.bsky.app/full.jpg" }] },
			"https://cdn.bsky.app/full.jpg",
		],
		[
			"a video",
			{ thumbnail: "https://video.bsky.app/thumb.jpg" },
			"https://video.bsky.app/thumb.jpg",
		],
		[
			"a link card",
			{ external: { thumb: "https://cdn.bsky.app/card.jpg" } },
			"https://cdn.bsky.app/card.jpg",
		],
		[
			"a quote with media",
			{ media: { images: [{ fullsize: "https://cdn.bsky.app/q.jpg" }] } },
			"https://cdn.bsky.app/q.jpg",
		],
	])("finds the picture of %s", async (_, embed, imageUrl) => {
		const [item] = await fetchItems({ post: { ...Entry.post, embed } });

		expect(item.imageUrl).toBe(imageUrl);
	});

	it("marks adult content so the channel gate can see it", async () => {
		const [item] = await fetchItems({
			post: { ...Entry.post, labels: [{ val: "porn" }] },
		});

		expect(item.isNsfw).toBe(true);
	});

	it("marks a post by an account labelled as adult", async () => {
		const [item] = await fetchItems({
			post: {
				...Entry.post,
				author: { ...Author, labels: [{ val: "sexual" }] },
			},
		});

		expect(item.isNsfw).toBe(true);
	});

	it("drops a reposted author who opted out of logged-out access", async () => {
		const optedOut = {
			...Author,
			labels: [{ val: "!no-unauthenticated" }],
		};

		const items = await fetchItems({
			post: { ...Entry.post, author: optedOut },
		});

		expect(items).toEqual([]);
	});

	it.each([
		[
			"a rate limit",
			json({}, { status: 429, headers: { "retry-after": "10" } }),
			{ _tag: "RateLimited", retryAfterMs: 10_000 },
		],
		[
			"an account that disappeared",
			json({}, { status: 400 }),
			{ _tag: "TargetUnavailable" },
		],
		["an outage", json({}, { status: 502 }), { _tag: "Unavailable" }],
		["garbage", new Response("nope"), { _tag: "InvalidResponse" }],
		["an unexpected shape", json({ posts: [] }), { _tag: "InvalidResponse" }],
	])("reports %s", async (_, answer, failure) => {
		fetchMock.mockResolvedValueOnce(answer);

		const result = await provider.fetchLatest(Did, null);

		expect(result.unwrapErr()).toEqual(failure);
	});
});
