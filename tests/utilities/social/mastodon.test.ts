import type { PublicFetcher, PublicResponse } from "#social/publicFetch";
import { createMastodonProvider } from "#social/providers/mastodon";
import { err, ok } from "@sapphire/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn<PublicFetcher>();
const provider = createMastodonProvider(fetchMock);

const Target = "mastodon.social/13179";
const Account = {
	id: "13179",
	acct: "Mastodon",
	username: "Mastodon",
	display_name: "Mastodon",
	avatar: "https://files.mastodon.social/avatar.png",
};
const Status = {
	id: "100",
	url: "https://mastodon.social/@Mastodon/100",
	uri: "https://mastodon.social/users/Mastodon/statuses/100",
	created_at: "2026-11-01T10:00:00.000Z",
	in_reply_to_id: null,
	visibility: "public",
	sensitive: false,
	spoiler_text: "",
	content: "<p>Hello <a href='#'>world</a></p>",
	reblog: null,
	account: Account,
	media_attachments: [],
};

function respond(
	body: unknown,
	overrides: Partial<PublicResponse> = {},
): Awaited<ReturnType<PublicFetcher>> {
	return ok({
		status: 200,
		url: "https://mastodon.social/",
		headers: {},
		body: typeof body === "string" ? body : JSON.stringify(body),
		...overrides,
	});
}

beforeEach(() => {
	fetchMock.mockReset();
});

async function fetchItems(...statuses: object[]) {
	fetchMock.mockResolvedValueOnce(respond(statuses));
	const result = await provider.fetchLatest(Target, null);
	return (result.unwrap() as unknown as { items: Record<string, unknown>[] })
		.items;
}

describe("validateTarget", () => {
	it.each([
		"@Mastodon@mastodon.social",
		"Mastodon@mastodon.social",
		"https://mastodon.social/@Mastodon",
		"https://mastodon.social/@Mastodon/",
		"Mastodon@MASTODON.social",
	])("resolves %s to the host and the account id", async (input) => {
		fetchMock.mockResolvedValueOnce(respond(Account));

		const result = await provider.validateTarget(input);

		expect(result.unwrap()).toEqual({
			target: Target,
			displayName: "Mastodon",
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://mastodon.social/api/v1/accounts/lookup?acct=Mastodon",
		);
	});

	it.each(["Mastodon", "@Mastodon", "https://mastodon.social/about", "a@b"])(
		"refuses %j without calling anything",
		async (input) => {
			const result = await provider.validateTarget(input);

			expect(result.unwrapErr()).toEqual({ _tag: "InvalidTarget" });
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		["a missing account", respond("", { status: 404 }), "TargetNotFound"],
		[
			"a server that refuses anonymous reads",
			respond("", { status: 401 }),
			"TargetBlocked",
		],
		["an outage", respond("", { status: 502 }), "TargetUnreachable"],
		[
			"a server that is not Fediverse software",
			respond("<html></html>"),
			"TargetUnsupported",
		],
		[
			"a host on a private network",
			err({ _tag: "ForbiddenAddress" }),
			"TargetBlocked",
		],
		[
			"an id that could not be stored safely",
			respond({ ...Account, id: "../../admin" }),
			"TargetUnsupported",
		],
		["a dead host", err({ _tag: "Timeout" }), "TargetUnreachable"],
	] as const)("explains %s", async (_, answer, tag) => {
		fetchMock.mockResolvedValueOnce(answer as never);

		const result = await provider.validateTarget("a@example.social");

		expect(result.unwrapErr()).toEqual({ _tag: tag });
	});
});

describe("fetchLatest", () => {
	it("turns a status into plain text with its public link", async () => {
		const [item] = await fetchItems(Status);

		expect(item).toEqual({
			id: "100",
			url: Status.url,
			title: null,
			text: "Hello world",
			authorName: "Mastodon",
			authorAvatarUrl: Account.avatar,
			imageUrl: null,
			publishedAt: new Date(Status.created_at),
			isReply: false,
			isRepost: false,
		});
	});

	it("reads the statuses from the account's own server", async () => {
		await fetchItems();

		expect(fetchMock.mock.calls[0][0]).toContain(
			"https://mastodon.social/api/v1/accounts/13179/statuses",
		);
	});

	it.each(["unlisted", "private", "direct"])(
		"leaves out a %s status",
		async (visibility) => {
			expect(await fetchItems({ ...Status, visibility })).toEqual([]);
		},
	);

	it.each([
		["a numeric id", { id: 123 }],
		["no account", { account: null }],
		["no date", { created_at: undefined }],
		["not even an object", null],
	])("skips a status with %s", async (_, overrides) => {
		const status = overrides === null ? null : { ...Status, ...overrides };

		expect(await fetchItems(status as never)).toEqual([]);
	});

	it("reads fields of the wrong type as missing", async () => {
		const [item] = await fetchItems({
			...Status,
			content: 5,
			spoiler_text: 7,
			media_attachments: "none",
			account: { ...Account, display_name: 9 },
		});

		expect(item).toMatchObject({
			text: "",
			imageUrl: null,
			authorName: "@Mastodon",
		});
	});

	it("flags a reply", async () => {
		const [item] = await fetchItems({ ...Status, in_reply_to_id: "99" });

		expect(item.isReply).toBe(true);
	});

	it("shows the boosted post under the id of the boost", async () => {
		const original = {
			...Status,
			id: "50",
			content: "<p>Boosted</p>",
			url: "https://other.social/@b/50",
			account: { ...Account, display_name: "Booster's friend" },
		};

		const [item] = await fetchItems({ ...Status, reblog: original });

		expect(item).toMatchObject({
			id: "100",
			text: "Boosted",
			url: original.url,
			authorName: "Booster's friend",
			isRepost: true,
		});
	});

	it("leaves out a public boost of a post that is not public", async () => {
		const original = { ...Status, id: "50", visibility: "unlisted" };

		expect(await fetchItems({ ...Status, reblog: original })).toEqual([]);
	});

	it("reads a boosted reply as a reply, since that is what gets shown", async () => {
		const original = { ...Status, id: "50", in_reply_to_id: "49" };

		const [item] = await fetchItems({ ...Status, reblog: original });

		expect(item.isReply).toBe(true);
	});

	it("uses the first picture of a status", async () => {
		const [item] = await fetchItems({
			...Status,
			media_attachments: [
				{ type: "audio" },
				{ type: "image", preview_url: "https://files.example/p.png" },
			],
		});

		expect(item.imageUrl).toBe("https://files.example/p.png");
	});

	it("keeps a content warning in front of what it hides", async () => {
		const [item] = await fetchItems({
			...Status,
			spoiler_text: "Spoilers",
			content: "<p>The ending</p>",
			media_attachments: [
				{ type: "image", preview_url: "https://files.example/p.png" },
			],
		});

		expect(item).toMatchObject({ text: "Spoilers", imageUrl: null });
	});

	it("hides the picture of a status marked as sensitive", async () => {
		const [item] = await fetchItems({
			...Status,
			sensitive: true,
			media_attachments: [
				{ type: "image", preview_url: "https://files.example/p.png" },
			],
		});

		expect(item.imageUrl).toBeNull();
	});

	it.each([
		[
			"a rate limit",
			respond("", { status: 429, headers: { "retry-after": "5" } }),
			{ _tag: "RateLimited", retryAfterMs: 5000 },
		],
		[
			"a gone account",
			respond("", { status: 404 }),
			{ _tag: "TargetUnavailable" },
		],
		[
			"a closed server",
			respond("", { status: 403 }),
			{ _tag: "TargetUnavailable" },
		],
		["an outage", respond("", { status: 500 }), { _tag: "Unavailable" }],
		["garbage", respond("<html>"), { _tag: "InvalidResponse" }],
		["a dead host", err({ _tag: "Timeout" }), { _tag: "Unavailable" }],
		[
			"a host that moved to a private address",
			err({ _tag: "ForbiddenAddress" }),
			{ _tag: "TargetUnavailable" },
		],
	] as const)("reports %s", async (_, answer, failure) => {
		fetchMock.mockResolvedValueOnce(answer as never);

		const result = await provider.fetchLatest(Target, null);

		expect(result.unwrapErr()).toEqual(failure);
	});
});

describe("rateLimitScope", () => {
	it("keeps one budget per server", () => {
		expect(provider.rateLimitScope("a.social/1")).toBe(
			provider.rateLimitScope("a.social/2"),
		);
		expect(provider.rateLimitScope("a.social/1")).not.toBe(
			provider.rateLimitScope("b.social/1"),
		);
	});
});
