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
		const result = await makeProvider(env).fetchLatest(
			ChannelId,
			{ baselineRead: true },
			{
				checkRequested: false,
			},
		);
		expect(result.unwrap()).toEqual({ _tag: "NotModified" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("renews a short grant before expiry without reading videos", async () => {
		sourceStore.findUnique.mockResolvedValue({
			websubExpiresAt: new Date(Now + Time.Minute * 20),
		});
		fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
		await makeProvider(env).fetchLatest(
			ChannelId,
			{ baselineRead: true },
			{
				checkRequested: false,
			},
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
	});

	it("re-reads an unacknowledged delivery even without another push", async () => {
		sourceStore.findUnique.mockResolvedValue({
			websubExpiresAt: new Date(Now + Time.Hour * 12),
		});
		fetchMock.mockResolvedValueOnce(new Response(Feed));
		fetchMock.mockResolvedValueOnce(
			Response.json({
				items: [
					{
						id: "rPj14ToaZSA",
						snippet: { title: "Retry", description: "Caption" },
						contentDetails: { duration: "PT45S" },
					},
				],
			}),
		);
		const result = await makeProvider(env).fetchLatest(ChannelId, null, {
			checkRequested: false,
		});
		expect(result.unwrap()).toMatchObject({
			_tag: "Items",
			items: [{ title: "Retry" }],
			state: { baselineRead: true },
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it("surfaces a failed hub request for backoff and health reporting", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
		expect(
			(await makeProvider(env).onSubscribed!(ChannelId)).unwrapErr(),
		).toEqual({ _tag: "Unavailable" });
	});
});

describe("read and maintenance failures", () => {
	const env = { ...WebSubEnv, YOUTUBE_API_KEY: "key" };
	const sourceStore = { findUnique: vi.fn(), updateMany: vi.fn() };
	beforeEach(() => {
		container.prisma = { socialSource: sourceStore } as never;
		sourceStore.findUnique.mockResolvedValue({
			websubExpiresAt: new Date(Now + Time.Hour * 12),
			websubRequestedAt: null,
		});
		sourceStore.updateMany.mockResolvedValue({ count: 1 });
	});
	it.each([
		[404, "TargetUnavailable"],
		[403, "Unavailable"],
		[500, "Unavailable"],
	])("maps feed HTTP %i to %s", async (status, tag) => {
		fetchMock.mockResolvedValue(new Response(null, { status }));
		expect(
			(await makeProvider(env).fetchLatest(ChannelId, null)).unwrapErr(),
		).toEqual({ _tag: tag });
	});
	it("rejects an unrecognized feed", async () => {
		fetchMock.mockResolvedValue(new Response("not XML"));
		expect(
			(await makeProvider(env).fetchLatest(ChannelId, null)).unwrapErr(),
		).toEqual({ _tag: "InvalidResponse" });
	});
	it("keeps requested videos deliverable when hub renewal is refused", async () => {
		sourceStore.findUnique.mockResolvedValue({
			websubExpiresAt: null,
			websubRequestedAt: null,
		});
		fetchMock
			.mockResolvedValueOnce(new Response(null, { status: 403 }))
			.mockResolvedValueOnce(new Response(Feed))
			.mockResolvedValueOnce(
				Response.json({
					items: [
						{
							id: "rPj14ToaZSA",
							snippet: { title: "Push", description: "New video" },
							contentDetails: { duration: "PT30S" },
						},
					],
				}),
			);
		expect(
			(
				await makeProvider(env).fetchLatest(
					ChannelId,
					{ baselineRead: true },
					{ checkRequested: true },
				)
			).unwrap(),
		).toMatchObject({
			items: [{ title: "Push" }],
			failure: { _tag: "Unavailable" },
		});
	});
	it("reports an accepted but unconfirmed lease as failed after verification times out", async () => {
		sourceStore.findUnique.mockResolvedValue({
			websubExpiresAt: null,
			websubRequestedAt: new Date(Now - Time.Minute * 10),
		});
		fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
		expect(
			(
				await makeProvider(env).fetchLatest(
					ChannelId,
					{ baselineRead: true },
					{ checkRequested: false },
				)
			).unwrapErr(),
		).toEqual({ _tag: "Unavailable" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it.each(["quotaExceeded", "dailyLimitExceeded", "userRateLimitExceeded"])(
		"classifies %s separately from credentials",
		async (reason) => {
			fetchMock
				.mockResolvedValueOnce(new Response(Feed))
				.mockResolvedValueOnce(
					Response.json({ error: { errors: [{ reason }] } }, { status: 403 }),
				);
			expect(
				(await makeProvider(env).fetchLatest(ChannelId, null)).unwrapErr(),
			).toMatchObject({ _tag: "RateLimited" });
		},
	);
	it("keeps an actual metadata credential refusal visible", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(Feed))
			.mockResolvedValueOnce(
				Response.json(
					{ error: { errors: [{ reason: "forbidden" }] } },
					{ status: 403 },
				),
			);
		expect(
			(await makeProvider(env).fetchLatest(ChannelId, null)).unwrapErr(),
		).toEqual({ _tag: "AuthFailed" });
	});
	it("rejects metadata without an items array", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(Feed))
			.mockResolvedValueOnce(Response.json({ unexpected: true }));
		expect(
			(await makeProvider(env).fetchLatest(ChannelId, null)).unwrapErr(),
		).toEqual({ _tag: "InvalidResponse" });
	});
	it("retries a fresh video omitted from the metadata index but does not retry deleted archive videos forever", async () => {
		fetchMock.mockResolvedValue(new Response(""));
		const provider = makeProvider(env);
		const fresh = Feed.replaceAll(
			"2026-10-30T20:00:20+00:00",
			new Date(Now - Time.Minute).toISOString(),
		);
		fetchMock
			.mockReset()
			.mockResolvedValueOnce(new Response(fresh))
			.mockResolvedValueOnce(Response.json({ items: [] }));
		expect(
			(await provider.fetchLatest(ChannelId, null)).unwrap(),
		).toMatchObject({ items: [], state: null });
		fetchMock
			.mockResolvedValueOnce(new Response(Feed))
			.mockResolvedValueOnce(Response.json({ items: [] }));
		expect(
			(await provider.fetchLatest(ChannelId, null)).unwrap(),
		).toMatchObject({ items: [], state: { baselineRead: true } });
	});
	it("preserves an explicit Shorts player link even if duration metadata disagrees", async () => {
		fetchMock.mockResolvedValueOnce(new Response(Feed)).mockResolvedValueOnce(
			Response.json({
				items: [
					{
						id: "rPj14ToaZSA",
						snippet: { title: "Short", description: "Caption" },
						contentDetails: { duration: "PT20M" },
					},
				],
			}),
		);
		expect(
			(await makeProvider(env).fetchLatest(ChannelId, null)).unwrap(),
		).toMatchObject({ items: [{ isShort: true }] });
	});
});

describe("unaccepted lease requests", () => {
	it.each(["transport", "refusal"])(
		"does not treat a %s failure as an accepted request awaiting verification",
		async (failure) => {
			let clock = Now;
			const row: {
				websubExpiresAt: Date | null;
				websubRequestedAt: Date | null;
			} = { websubExpiresAt: null, websubRequestedAt: null };
			container.prisma = {
				socialSource: {
					findUnique: vi.fn(async () => ({ ...row })),
					updateMany: vi.fn(async ({ where, data }) => {
						if (
							where.websubRequestedAt &&
							where.websubRequestedAt.getTime() !==
								row.websubRequestedAt?.getTime()
						)
							return { count: 0 };
						Object.assign(row, data);
						return { count: 1 };
					}),
				},
			} as never;
			if (failure === "transport")
				fetchMock.mockRejectedValueOnce(new Error("Connection lost"));
			else fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
			fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
			const provider = createYouTubeProvider({
				fetch: fetchMock,
				env: { ...WebSubEnv, YOUTUBE_API_KEY: "key" },
				now: () => clock,
			});
			expect((await provider.onSubscribed!(ChannelId)).isErr()).toBe(true);
			clock += Time.Minute * 10;
			expect((await provider.onSubscribed!(ChannelId)).isOk()).toBe(true);
		},
	);
});
