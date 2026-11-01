import type { SocialItem } from "#social/provider";
import { createRedditProvider } from "#social/providers/reddit";
import { Time } from "@sapphire/time-utilities";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Env = {
	REDDIT_CLIENT_ID: "id",
	REDDIT_CLIENT_SECRET: "secret",
	REDDIT_USERNAME: "staryl_bot",
	CLIENT_VERSION: "1.2.3",
};

const fetchMock = vi.fn<typeof fetch>();
let now = 0;

function json(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), init);
}

const tokenResponse = (value = "token") =>
	json({ access_token: value, expires_in: 86_400 });

const Post = {
	name: "t3_abc",
	title: "A title",
	selftext: "Some text",
	author: "alice",
	permalink: "/r/typescript/comments/abc/a_title/",
	created_utc: 1_800_000_000,
	link_flair_text: "News",
	over_18: false,
	score: 12,
	preview: { images: [{ source: { url: "https://i.redd.it/picture.png" } }] },
};

const listing = (...posts: object[]) =>
	json({ data: { children: posts.map((data) => ({ data })) } });

function makeProvider(env: Record<string, string> = Env) {
	return createRedditProvider({ fetch: fetchMock, env, now: () => now });
}

/** Answers the token request, then each call in order. */
function respond(...answers: Response[]) {
	fetchMock.mockResolvedValueOnce(tokenResponse());
	for (const answer of answers) fetchMock.mockResolvedValueOnce(answer);
}

beforeEach(() => {
	fetchMock.mockReset();
	now = 0;
});

describe("getAuthRequirements", () => {
	it("is satisfied once every credential is set", () => {
		expect(makeProvider().getAuthRequirements().satisfied).toBe(true);
	});

	it("keeps the provider off without them", () => {
		const { satisfied, variables } = makeProvider({
			REDDIT_CLIENT_ID: "id",
		}).getAuthRequirements();

		expect(satisfied).toBe(false);
		expect(variables).toContain("REDDIT_CLIENT_SECRET");
	});
});

describe("authentication", () => {
	it("asks for an app token with its credentials and names itself", async () => {
		respond(listing());

		await makeProvider().fetchLatest("typescript", null);

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://www.reddit.com/api/v1/access_token");
		expect(init?.body).toBe("grant_type=client_credentials");
		expect(init?.headers).toMatchObject({
			authorization: `Basic ${btoa("id:secret")}`,
			"user-agent": "linux:rocks.wolfstar.staryl:v1.2.3 (by /u/staryl_bot)",
		});
	});

	it("calls the API with the token, on the OAuth host", async () => {
		respond(listing());

		await makeProvider().fetchLatest("typescript", null);

		const [url, init] = fetchMock.mock.calls[1];
		expect(String(url)).toContain("https://oauth.reddit.com/r/typescript/new");
		expect(init?.headers).toMatchObject({ authorization: "bearer token" });
	});

	it("reuses the token until it is about to expire", async () => {
		const provider = makeProvider();
		respond(listing());
		await provider.fetchLatest("typescript", null);

		fetchMock.mockResolvedValueOnce(listing());
		await provider.fetchLatest("typescript", null);
		expect(fetchMock).toHaveBeenCalledTimes(3);

		now = Time.Day;
		respond(listing());
		await provider.fetchLatest("typescript", null);
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it("gets a new token when Reddit stops accepting the old one", async () => {
		const provider = makeProvider();
		respond(new Response(null, { status: 401 }));
		fetchMock.mockResolvedValueOnce(tokenResponse("fresh"));
		fetchMock.mockResolvedValueOnce(listing(Post));

		const result = await provider.fetchLatest("typescript", null);

		expect(result.isOk()).toBe(true);
		expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({
			authorization: "bearer fresh",
		});
	});

	it("does not blame the credentials for a token answer that broke off", async () => {
		fetchMock.mockResolvedValueOnce(new Response("<html>"));

		const result = await makeProvider().fetchLatest("typescript", null);

		expect(result.unwrapErr()).toEqual({ _tag: "Unavailable" });
	});

	it("reports a token answer without a token", async () => {
		fetchMock.mockResolvedValueOnce(json({ error: "invalid_grant" }));

		const result = await makeProvider().fetchLatest("typescript", null);

		expect(result.unwrapErr()).toEqual({ _tag: "AuthFailed" });
	});

	it("reports refused credentials", async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

		const result = await makeProvider().fetchLatest("typescript", null);

		expect(result.unwrapErr()).toEqual({ _tag: "AuthFailed" });
	});
});

describe("validateTarget", () => {
	const about = (name: string) =>
		json({ kind: "t5", data: { display_name: name } });

	it.each([
		"TypeScript",
		"r/TypeScript",
		"/r/TypeScript/",
		"https://www.reddit.com/r/TypeScript/",
		"https://old.reddit.com/r/TypeScript",
	])("resolves %s to one canonical target", async (input) => {
		respond(about("TypeScript"));

		const result = await makeProvider().validateTarget(input);

		expect(result.unwrap()).toEqual({
			target: "typescript",
			displayName: "r/TypeScript",
		});
	});

	it.each(["a b", "r/", "https://example.com/r/foo", "x", "../etc"])(
		"refuses %j without asking Reddit",
		async (input) => {
			const result = await makeProvider().validateTarget(input);

			expect(result.unwrapErr()).toEqual({ _tag: "InvalidTarget" });
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		["a redirect to search", new Response(null, { status: 302 })],
		["a banned subreddit", new Response(null, { status: 404 })],
		["a private subreddit", new Response(null, { status: 403 })],
		["something that is not a subreddit", json({ kind: "Listing", data: {} })],
	])("treats %s as not found", async (_, answer) => {
		respond(answer);

		const result = await makeProvider().validateTarget("somewhere");

		expect(result.unwrapErr()).toEqual({ _tag: "TargetNotFound" });
	});

	it("does not mistake an outage for a missing subreddit", async () => {
		respond(new Response(null, { status: 500 }));

		const result = await makeProvider().validateTarget("typescript");

		expect(result.unwrapErr()).toEqual({ _tag: "TargetUnreachable" });
	});
});

describe("fetchLatest", () => {
	it("maps a post with everything the filters need", async () => {
		respond(listing(Post));

		const result = await makeProvider().fetchLatest("typescript", null);

		expect(result.unwrap()).toEqual({
			_tag: "Items",
			state: null,
			items: [
				{
					id: "t3_abc",
					url: "https://www.reddit.com/r/typescript/comments/abc/a_title/",
					title: "A title",
					text: "Some text",
					authorName: "u/alice",
					authorAvatarUrl: null,
					imageUrl: "https://i.redd.it/picture.png",
					publishedAt: new Date(1_800_000_000_000),
					isNsfw: false,
					isSpoiler: false,
					flair: "News",
					score: 12,
				},
			],
		});
	});

	it("marks NSFW posts so the channel gate can see them", async () => {
		respond(listing({ ...Post, over_18: true }));

		const result = await makeProvider().fetchLatest("typescript", null);

		expect(result.unwrap()).toMatchObject({ items: [{ isNsfw: true }] });
	});

	it("keeps a spoiler readable for the filters, and out of the card", async () => {
		respond(listing({ ...Post, spoiler: true }));
		const provider = makeProvider();

		const result = await provider.fetchLatest("typescript", null);

		const [item] = (result.unwrap() as { items: SocialItem[] }).items;
		expect(item).toMatchObject({ text: "Some text", isSpoiler: true });
		expect(
			provider.formatNotification(
				item,
				{ target: "typescript", displayName: "r/typescript" },
				vi.fn() as never,
			),
		).toMatchObject({ body: null, imageUrl: null });
	});

	it.each([
		[
			"a rate limit",
			new Response(null, { status: 429, headers: { "retry-after": "30" } }),
			{ _tag: "RateLimited", retryAfterMs: 30_000 },
		],
		[
			"a subreddit that went private",
			new Response(null, { status: 403 }),
			{ _tag: "TargetUnavailable" },
		],
		["an outage", new Response(null, { status: 503 }), { _tag: "Unavailable" }],
		["garbage", new Response("nope"), { _tag: "InvalidResponse" }],
		["an unexpected shape", json({ data: {} }), { _tag: "InvalidResponse" }],
	])("reports %s", async (_, answer, failure) => {
		respond(answer);

		const result = await makeProvider().fetchLatest("typescript", null);

		expect(result.unwrapErr()).toEqual(failure);
	});

	it("reports a request that failed to go out", async () => {
		fetchMock.mockResolvedValueOnce(tokenResponse());
		fetchMock.mockRejectedValueOnce(new Error("socket hang up"));

		const result = await makeProvider().fetchLatest("typescript", null);

		expect(result.unwrapErr()).toEqual({ _tag: "Unavailable" });
	});
});

describe("rateLimitScope", () => {
	it("shares one budget, since Reddit counts per app", () => {
		const provider = makeProvider();

		expect(provider.rateLimitScope("a")).toBe(provider.rateLimitScope("b"));
	});
});
