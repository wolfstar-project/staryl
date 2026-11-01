import { readFileSync } from "node:fs";
import { createYouTubeProvider } from "#social/providers/youtube";
import { getCallbackToken } from "#social/websub";
import { Time } from "@sapphire/time-utilities";
import { container } from "@wolfstar/http-framework";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Feed = readFileSync(
	new URL("../../fixtures/youtube.xml", import.meta.url),
	"utf8",
);
const ChannelId = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
const WebSubEnv = {
	YOUTUBE_WEBSUB_CALLBACK: "https://staryl.example/youtube/websub",
	YOUTUBE_WEBSUB_SECRET: "secret",
};
const Now = Date.UTC(2026, 10, 1);

const fetchMock = vi.fn<typeof fetch>();

function makeProvider(env: Record<string, string> = {}) {
	return createYouTubeProvider({ fetch: fetchMock, env, now: () => Now });
}

beforeEach(() => {
	fetchMock.mockReset();
});

describe("validateTarget", () => {
	it.each([
		ChannelId,
		`https://www.youtube.com/channel/${ChannelId}`,
		`https://youtube.com/channel/${ChannelId}/videos`,
		`www.youtube.com/channel/${ChannelId}?sub_confirmation=1`,
	])("reads the channel named by %s", async (input) => {
		fetchMock.mockResolvedValueOnce(new Response(Feed));

		const result = await makeProvider().validateTarget(input);

		expect(result.unwrap()).toEqual({
			target: ChannelId,
			displayName: "Google for Developers",
		});
	});

	it("resolves a handle through the Data API when a key is set", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({ items: [{ id: ChannelId }] }),
		);
		fetchMock.mockResolvedValueOnce(new Response(Feed));

		const provider = makeProvider({ YOUTUBE_API_KEY: "key" });
		const result = await provider.validateTarget("@GoogleDevelopers");

		const url = new URL(String(fetchMock.mock.calls[0][0]));
		expect(url.host).toBe("www.googleapis.com");
		expect(url.searchParams.get("forHandle")).toBe("@GoogleDevelopers");
		expect(result.unwrap().target).toBe(ChannelId);
	});

	it("never reads a channel page to resolve a handle", async () => {
		const result = await makeProvider().validateTarget(
			"https://www.youtube.com/@GoogleDevelopers",
		);

		expect(result.unwrapErr()).toEqual({ _tag: "InvalidTarget" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports a handle that does not exist", async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ items: [] }));

		const provider = makeProvider({ YOUTUBE_API_KEY: "key" });
		const result = await provider.validateTarget("@nobody123");

		expect(result.unwrapErr()).toEqual({ _tag: "TargetNotFound" });
	});

	it("reports a spent API quota as a temporary problem", async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));

		const provider = makeProvider({ YOUTUBE_API_KEY: "key" });
		const result = await provider.validateTarget("@GoogleDevelopers");

		expect(result.unwrapErr()).toEqual({ _tag: "TargetUnreachable" });
	});

	it.each(["not a channel", "UCshort", "https://example.com/channel/UCxx"])(
		"refuses %j",
		async (input) => {
			const result = await makeProvider().validateTarget(input);

			expect(result.unwrapErr()).toEqual({ _tag: "InvalidTarget" });
		},
	);

	it("reports a channel that does not exist", async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

		const result = await makeProvider().validateTarget(ChannelId);

		expect(result.unwrapErr()).toEqual({ _tag: "TargetNotFound" });
	});
});

describe("fetchLatest", () => {
	it("maps each video and tells Shorts apart by their player link", async () => {
		fetchMock.mockResolvedValueOnce(new Response(Feed));

		const result = await makeProvider().fetchLatest(ChannelId, null);

		expect(result.unwrap()).toMatchObject({
			_tag: "Items",
			items: [
				{
					id: "yt:video:rPj14ToaZSA",
					title: "A short one",
					text: "Quick tip",
					isShort: true,
					imageUrl: "https://i3.ytimg.com/vi/rPj14ToaZSA/hqdefault.jpg",
				},
				{
					id: "yt:video:rsOiZE19RVo",
					url: "https://www.youtube.com/watch?v=rsOiZE19RVo",
					isShort: false,
				},
			],
		});
	});

	it("does not talk to the hub without WebSub configured", async () => {
		fetchMock.mockResolvedValueOnce(new Response(Feed));

		await makeProvider().fetchLatest(ChannelId, null);

		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("subscribes to the hub with the secret, for the channel's topic", async () => {
		fetchMock.mockResolvedValueOnce(new Response(Feed));
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));

		const result = await makeProvider(WebSubEnv).fetchLatest(ChannelId, null);

		const [url, init] = fetchMock.mock.calls[1];
		const body = init!.body as URLSearchParams;
		expect(url).toBe("https://pubsubhubbub.appspot.com/subscribe");
		expect(Object.fromEntries(body)).toMatchObject({
			"hub.callback": `${WebSubEnv.YOUTUBE_WEBSUB_CALLBACK}?token=${getCallbackToken("secret", ChannelId)}`,
			"hub.mode": "subscribe",
			"hub.secret": "secret",
			"hub.topic": `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${ChannelId}`,
		});
		expect(result.unwrap()).toMatchObject({
			state: { leaseRequestedAt: Now },
		});
	});

	it("leaves a recent lease alone", async () => {
		fetchMock.mockResolvedValueOnce(new Response(Feed));

		await makeProvider(WebSubEnv).fetchLatest(ChannelId, {
			leaseRequestedAt: Now - Time.Day,
		});

		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("renews a lease well before it can expire", async () => {
		fetchMock.mockResolvedValueOnce(new Response(Feed));
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));

		await makeProvider(WebSubEnv).fetchLatest(ChannelId, {
			leaseRequestedAt: Now - Time.Day * 4,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("still delivers when the hub is down, and retries on the next check", async () => {
		const warn = vi
			.spyOn(container.logger, "warn")
			.mockImplementation(() => undefined);
		fetchMock.mockResolvedValueOnce(new Response(Feed));
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

		const result = await makeProvider(WebSubEnv).fetchLatest(ChannelId, null);

		expect(result.unwrap()).toMatchObject({ _tag: "Items", state: {} });
		expect(result.unwrap()).not.toHaveProperty("state.leaseRequestedAt");
		expect(warn).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"a removed channel",
			new Response(null, { status: 404 }),
			"TargetUnavailable",
		],
		[
			"a refusal, which is not about credentials",
			new Response(null, { status: 403 }),
			"Unavailable",
		],
		["an outage", new Response(null, { status: 500 }), "Unavailable"],
		["garbage", new Response("nope"), "InvalidResponse"],
	])("reports %s", async (_, answer, tag) => {
		fetchMock.mockResolvedValueOnce(answer);

		const result = await makeProvider().fetchLatest(ChannelId, null);

		expect(result.unwrapErr()).toEqual({ _tag: tag });
	});
});
