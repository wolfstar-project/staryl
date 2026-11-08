import { readFileSync } from "node:fs";
import { createYouTubeProvider } from "#social/providers/youtube";
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

describe("WebSub lifecycle", () => {
	const sourceStore = { findUnique: vi.fn(), updateMany: vi.fn() };
	const env = { ...WebSubEnv, YOUTUBE_API_KEY: "key" };
	beforeEach(() => {
		container.prisma = { socialSource: sourceStore } as never;
		sourceStore.findUnique.mockResolvedValue({ websubExpiresAt: null });
		sourceStore.updateMany.mockResolvedValue({ count: 1 });
	});
	it("baselines with Data API metadata without subscribing before save", async () => {
		fetchMock.mockResolvedValueOnce(new Response(Feed));
		fetchMock.mockResolvedValueOnce(
			Response.json({
				items: [
					{
						id: "rPj14ToaZSA",
						snippet: { title: "Short", description: "Caption" },
						contentDetails: { duration: "PT45S" },
					},
					{
						id: "rsOiZE19RVo",
						snippet: { title: "Long", description: "Long description" },
						contentDetails: { duration: "PT20M" },
					},
				],
			}),
		);
		const result = await makeProvider(env).fetchLatest(ChannelId, null);
		expect(result.unwrap()).toMatchObject({
			items: [
				{ title: "Short", isShort: true },
				{ title: "Long", isShort: false },
			],
		});
		expect(
			fetchMock.mock.calls.every(([, init]) => init?.method !== "POST"),
		).toBe(true);
		expect(sourceStore.findUnique).not.toHaveBeenCalled();
	});
	it("subscribes after the source exists, requesting at most one day", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
		const result = await makeProvider(env).onSubscribed!(ChannelId);
		expect(result.isOk()).toBe(true);
		const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
		expect(body.get("hub.lease_seconds")).toBe("86400");
		expect(body.get("hub.topic")).toContain(ChannelId);
	});
	it("never asks the hub to verify a missing source", async () => {
		sourceStore.findUnique.mockResolvedValue(null);
		expect((await makeProvider(env).onSubscribed!(ChannelId)).isErr()).toBe(
			true,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("uses scheduled checks only for lease maintenance", async () => {
		sourceStore.findUnique.mockResolvedValue({
			websubExpiresAt: new Date(Now + Time.Hour * 12),
		});
		const result = await makeProvider(env).fetchLatest(ChannelId, null, {
			checkRequested: false,
		});
		expect(result.unwrap()).toEqual({ _tag: "NotModified" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("renews a short grant before expiry without reading videos", async () => {
		sourceStore.findUnique.mockResolvedValue({
			websubExpiresAt: new Date(Now + Time.Minute * 20),
		});
		fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
		await makeProvider(env).fetchLatest(ChannelId, null, {
			checkRequested: false,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
	});
	it("surfaces a failed hub request for backoff and health reporting", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
		expect(
			(await makeProvider(env).onSubscribed!(ChannelId)).unwrapErr(),
		).toEqual({ _tag: "Unavailable" });
	});
});
