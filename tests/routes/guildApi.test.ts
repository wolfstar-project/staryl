import type { ApiRequest, ApiResponse, Route } from "@wolfstar/plugin-api";
import { readFileSync } from "node:fs";
import { DiscordAPIError } from "@discordjs/rest";
import { ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import {
	addEventSubscription,
	areTwitchClientCredentialsSet,
	areTwitchEventSubCredentialsSet,
	fetchUsers,
	removeEventSubscription,
} from "@wolfstar/twitch-helpers";
import { PermissionFlagsBits } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserRoute as GetRoute } from "../../src/routes/guilds/[guild]/notifications.get.ts";
import { UserRoute as PatchRoute } from "../../src/routes/guilds/[guild]/notifications.patch.ts";
import { UserRoute as AddRoute } from "../../src/routes/guilds/[guild]/subscriptions.post.ts";
import { UserRoute as RemoveRoute } from "../../src/routes/guilds/[guild]/subscriptions/[channel]/[source].delete.ts";
import { UserRoute as EditRoute } from "../../src/routes/guilds/[guild]/subscriptions/[channel]/[source].patch.ts";
import { UserRoute as TwitchAddRoute } from "../../src/routes/guilds/[guild]/twitch.post.ts";
import { UserRoute as TwitchRemoveRoute } from "../../src/routes/guilds/[guild]/twitch/[channel]/[subscription].delete.ts";
import { UserRoute as TwitchEditRoute } from "../../src/routes/guilds/[guild]/twitch/[channel]/[subscription].patch.ts";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("#social/publicFetch", () => ({ fetchPublicUrl: fetchMock }));

const apiMock = vi.hoisted(() => ({
	guilds: { get: vi.fn(), getChannels: vi.fn(), getMember: vi.fn() },
	users: { getCurrent: vi.fn() },
}));
vi.mock("#utils/discordApi", () => ({ api: () => apiMock }));

vi.mock("@wolfstar/twitch-helpers", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@wolfstar/twitch-helpers")>();
	return {
		...actual,
		addEventSubscription: vi.fn(),
		areTwitchClientCredentialsSet: vi.fn(),
		areTwitchEventSubCredentialsSet: vi.fn(),
		fetchUsers: vi.fn(),
		removeEventSubscription: vi.fn(),
	};
});

const Rss = readFileSync(
	new URL("../fixtures/rss.xml", import.meta.url),
	"utf8",
);
const Secret = "a-secret-only-the-dashboard-knows";
const GuildId = "737141877803057244";
const ChannelId = "800000000000000001";
const ActorId = "266624760782258186";
const FeedUrl = "https://example.com/feed.xml";
const BotRoleId = "900000000000000001";

const prismaMock = {
	$queryRaw: vi.fn(),
	$transaction: vi.fn(),
	guild: { findUnique: vi.fn(), upsert: vi.fn() },
	guildSubscription: {
		count: vi.fn(),
		create: vi.fn(),
		delete: vi.fn(),
		findMany: vi.fn(),
		findUnique: vi.fn(),
		update: vi.fn(),
	},
	twitchSubscription: { create: vi.fn(), delete: vi.fn(), findFirst: vi.fn() },
	guildSocialSubscription: {
		count: vi.fn(),
		create: vi.fn(),
		delete: vi.fn(),
		findFirst: vi.fn(),
		findMany: vi.fn(),
		findUnique: vi.fn(),
		update: vi.fn(),
	},
	socialSource: { deleteMany: vi.fn() },
};

function makeSubscription(overrides: Record<string, unknown> = {}) {
	return {
		guildId: BigInt(GuildId),
		channelId: BigInt(ChannelId),
		sourceId: 5n,
		message: null,
		filters: {},
		lastNotifiedId: null,
		seenItemIds: [],
		deliveryError: null,
		createdAt: new Date("2026-11-01T10:00:00.000Z"),
		source: {
			id: 5n,
			provider: "Rss",
			target: FeedUrl,
			displayName: "Example feed",
			state: null,
			lastFailure: null,
			failureCount: 0,
			lastCheckedAt: new Date("2026-11-02T10:00:00.000Z"),
		},
		...overrides,
	};
}

interface Answer {
	status: number;
	body: unknown;
}

/** Runs a route as the server would, and answers with what the caller reads. */
async function call(
	RouteClass: new (...args: never[]) => Route,
	options: {
		token?: string | null;
		params?: Record<string, string>;
		body?: unknown;
	} = {},
): Promise<Answer> {
	const answer: Answer = { status: 200, body: undefined };
	const response = {
		status(code: number) {
			answer.status = code;
			return response;
		},
		json(data: unknown) {
			answer.body = data;
		},
		error(code: number, data: unknown) {
			answer.status = code;
			answer.body = { error: data };
		},
	};
	const token = options.token === undefined ? Secret : options.token;
	const request = {
		headers: {
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			"x-actor-id": ActorId,
		},
		params: { guild: GuildId, ...options.params },
		readBodyJson: async () => options.body,
	};

	const route = Object.create(RouteClass.prototype) as Route;
	await route.run(
		request as unknown as ApiRequest,
		response as unknown as ApiResponse,
	);
	return answer;
}

/** The bot is in the guild and may post in the channel. */
function allowPosting(channel: Record<string, unknown> = {}) {
	apiMock.guilds.get.mockResolvedValue({
		preferred_locale: "en-US",
		roles: [
			{ id: GuildId, permissions: "0" },
			{
				id: BotRoleId,
				permissions: String(
					PermissionFlagsBits.ViewChannel |
						PermissionFlagsBits.SendMessages |
						PermissionFlagsBits.EmbedLinks,
				),
			},
		],
	});
	apiMock.guilds.getChannels.mockResolvedValue([
		{ id: ChannelId, name: "general", type: 0, guild_id: GuildId, ...channel },
	]);
	apiMock.users.getCurrent.mockResolvedValue({ id: "bot-id" });
	apiMock.guilds.getMember.mockResolvedValue({ roles: [BotRoleId] });
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("GUILD_API_SECRET", Secret);
	container.prisma = prismaMock as never;

	fetchMock.mockResolvedValue(
		ok({ status: 200, url: FeedUrl, headers: {}, body: Rss }),
	);
	allowPosting();
	vi.mocked(fetchUsers).mockResolvedValue({
		data: [{ id: "123", display_name: "CoolStreamer" }],
	} as never);
	prismaMock.$queryRaw.mockResolvedValue([]);
	prismaMock.$transaction.mockImplementation(
		(run: (transaction: typeof prismaMock) => unknown) => run(prismaMock),
	);
	vi.mocked(areTwitchClientCredentialsSet).mockReturnValue(true);
	vi.mocked(areTwitchEventSubCredentialsSet).mockReturnValue(true);
	vi.mocked(addEventSubscription).mockResolvedValue({
		id: "eventsub-1",
	} as never);
	vi.mocked(removeEventSubscription).mockResolvedValue(undefined as never);
	prismaMock.guildSubscription.create.mockResolvedValue({});
	prismaMock.guildSubscription.count.mockResolvedValue(0);
	prismaMock.guildSubscription.delete.mockResolvedValue({});
	prismaMock.guildSubscription.findUnique.mockResolvedValue(null);
	prismaMock.twitchSubscription.findFirst.mockResolvedValue(null);
	prismaMock.twitchSubscription.delete.mockResolvedValue({});
	prismaMock.guild.findUnique.mockResolvedValue(null);
	prismaMock.guild.upsert.mockResolvedValue({});
	prismaMock.guildSubscription.findMany.mockResolvedValue([]);
	prismaMock.guildSocialSubscription.count.mockResolvedValue(0);
	prismaMock.guildSocialSubscription.create.mockResolvedValue({});
	prismaMock.guildSocialSubscription.delete.mockResolvedValue({});
	prismaMock.guildSocialSubscription.findFirst.mockResolvedValue(null);
	prismaMock.guildSocialSubscription.findMany.mockResolvedValue([]);
	prismaMock.guildSocialSubscription.findUnique.mockResolvedValue(null);
	prismaMock.socialSource.deleteMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the credential of the guild API", () => {
	it("is closed while no secret is configured", async () => {
		vi.stubEnv("GUILD_API_SECRET", "");

		const answer = await call(GetRoute);

		expect(answer).toEqual({
			status: 503,
			body: { error: "guild-api-disabled" },
		});
		expect(prismaMock.guildSocialSubscription.findMany).not.toHaveBeenCalled();
	});

	it.each([
		["no token", null],
		["another token", "not-the-secret"],
		["a token the secret only starts with", Secret.slice(0, -1)],
	])("refuses %s", async (_name, token) => {
		const answer = await call(GetRoute, { token });

		expect(answer).toEqual({ status: 401, body: { error: "unauthorized" } });
	});

	it("refuses a guild that is not a snowflake", async () => {
		const answer = await call(GetRoute, { params: { guild: "1 OR 1=1" } });

		expect(answer).toEqual({ status: 400, body: { error: "invalid-guild" } });
	});
});

describe("GET /guilds/:guild/notifications", () => {
	it("reads a guild without a row as on, with nothing to list", async () => {
		const { status, body } = await call(GetRoute);

		expect(status).toBe(200);
		expect(body).toMatchObject({
			installed: true,
			enabled: true,
			subscriptions: [],
			twitch: [],
		});
	});

	it("gives each provider its own maximum, from the free values while Ring is not set up", async () => {
		const { body } = await call(GetRoute);
		const state = body as {
			limits: { subscriptions: number; twitchLive: number };
			providers: { name: string; maximum: number }[];
		};

		const maximum = (name: string) =>
			state.providers.find((provider) => provider.name === name)?.maximum;
		expect(maximum("YouTube")).toBe(10);
		expect(maximum("Reddit")).toBe(30);
		expect(maximum("Rss")).toBe(25);
		expect(state.limits.twitchLive).toBe(15);
		// No total of its own: the most a guild can hold is what its providers allow together.
		expect(state.limits.subscriptions).toBe(
			state.providers.reduce((total, provider) => total + provider.maximum, 0),
		);
	});

	it("says whether a Twitch live subscription can be added", async () => {
		vi.mocked(areTwitchClientCredentialsSet).mockReturnValue(false);

		const { body } = await call(GetRoute);

		expect(body).toMatchObject({ twitchLiveConfigured: false });
	});

	it("reports the switch once it was turned off", async () => {
		prismaMock.guild.findUnique.mockResolvedValue({
			notificationsEnabled: false,
		});

		const { body } = await call(GetRoute);

		expect(body).toMatchObject({ enabled: false });
	});

	it("lists a subscription with its health and what the last post failed on", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription({
				message: "New post!",
				filters: { includeKeywords: ["release"] },
				deliveryError: "MissingPermissions",
				source: {
					...makeSubscription().source,
					lastFailure: "RateLimited",
					failureCount: 1,
				},
			}),
		]);

		const { body } = await call(GetRoute);

		expect((body as { subscriptions: unknown[] }).subscriptions).toEqual([
			{
				provider: "Rss",
				sourceId: "5",
				channelId: ChannelId,
				displayName: "Example feed",
				target: FeedUrl,
				message: "New post!",
				filters: ["includeKeywords"],
				health: "rateLimited",
				deliveryError: "MissingPermissions",
				manageable: true,
				createdAt: "2026-11-01T10:00:00.000Z",
				lastCheckedAt: "2026-11-02T10:00:00.000Z",
			},
		]);
	});

	it("marks the subscription of a connected account as not manageable", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription({
				source: { ...makeSubscription().source, provider: "Instagram" },
			}),
		]);

		const { body } = await call(GetRoute);

		expect(
			(body as { subscriptions: { manageable: boolean }[] }).subscriptions[0]
				.manageable,
		).toBe(false);
	});

	it("says the bot is not in a guild Discord refuses it", async () => {
		apiMock.guilds.get.mockRejectedValue(
			new DiscordAPIError(
				{ code: 10004, message: "Unknown Guild" },
				10004,
				404,
				"GET",
				"/guilds",
				{},
			),
		);

		const { body } = await call(GetRoute);

		expect(body).toMatchObject({ installed: false });
	});

	it("does not read a Discord outage as the bot being removed", async () => {
		apiMock.guilds.get.mockRejectedValue(new Error("socket hang up"));

		const { body } = await call(GetRoute);

		expect(body).toMatchObject({ installed: true });
	});

	const liveSubscription = {
		guildId: BigInt(GuildId),
		channelId: BigInt(ChannelId),
		message: "Live!",
		subscriptionId: 1n,
		twitchSubscription: {
			id: 1n,
			streamerId: "123",
			subscriptionType: "StreamOnline",
			revokedReason: "authorization_revoked",
		},
	};

	it("lists the Twitch live subscriptions, revoked ones included", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([liveSubscription]);

		const { body } = await call(GetRoute);

		expect((body as { twitch: unknown[] }).twitch).toEqual([
			{
				subscriptionId: "1",
				streamerId: "123",
				streamerName: "CoolStreamer",
				channelId: ChannelId,
				type: "StreamOnline",
				message: "Live!",
				revoked: true,
			},
		]);
	});

	it("still lists a Twitch live subscription when Twitch does not answer", async () => {
		vi.mocked(fetchUsers).mockRejectedValue(new Error("Twitch is down"));
		prismaMock.guildSubscription.findMany.mockResolvedValue([liveSubscription]);

		const { body } = await call(GetRoute);

		expect((body as { twitch: unknown[] }).twitch).toMatchObject([
			{ streamerId: "123", streamerName: null },
		]);
	});
});

describe("PATCH /guilds/:guild/notifications", () => {
	it("stores the switch, creating the row of a guild that has none", async () => {
		const answer = await call(PatchRoute, { body: { enabled: false } });

		expect(answer).toEqual({
			status: 200,
			body: { enabled: false, previous: true },
		});
		expect(prismaMock.guild.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: BigInt(GuildId) },
				create: { id: BigInt(GuildId), notificationsEnabled: false },
				update: { notificationsEnabled: false },
			}),
		);
	});

	it("answers what the switch was, so a repeat reads as one", async () => {
		prismaMock.guild.findUnique.mockResolvedValue({
			notificationsEnabled: false,
		});

		const answer = await call(PatchRoute, { body: { enabled: false } });

		expect(answer.body).toEqual({ enabled: false, previous: false });
	});

	it.each([[{}], [{ enabled: "false" }], [null], ["off"]])(
		"refuses the body %j",
		async (body) => {
			const answer = await call(PatchRoute, { body });

			expect(answer).toEqual({ status: 400, body: { error: "invalid-body" } });
			expect(prismaMock.guild.upsert).not.toHaveBeenCalled();
		},
	);
});

describe("POST /guilds/:guild/subscriptions", () => {
	const body = { provider: "Rss", target: FeedUrl, channelId: ChannelId };

	it("follows the target and answers with the guild's subscriptions", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
		]);

		const answer = await call(AddRoute, {
			body: { ...body, message: "  New post!  " },
		});

		expect(answer.status).toBe(201);
		expect(answer.body).toMatchObject({
			subscription: { sourceId: "5", channelId: ChannelId, target: FeedUrl },
			subscriptions: [{ sourceId: "5", channelId: ChannelId }],
		});
		const { data } = prismaMock.guildSocialSubscription.create.mock.calls[0][0];
		expect(data).toMatchObject({
			channelId: BigInt(ChannelId),
			message: "New post!",
		});
	});

	it("still answers 201 when the list cannot be read after the subscription was saved", async () => {
		prismaMock.guildSocialSubscription.findMany.mockRejectedValue(
			new Error("connection lost"),
		);

		const answer = await call(AddRoute, { body });

		// A 500 here would have the caller try again, and be told the subscription is a duplicate.
		expect(answer).toEqual({
			status: 201,
			body: { subscription: null, subscriptions: null },
		});
		expect(prismaMock.guildSocialSubscription.create).toHaveBeenCalledOnce();
	});

	it.each([
		["an unknown provider", { ...body, provider: "Myspace" }],
		["an empty target", { ...body, target: "   " }],
		["a channel that is not a snowflake", { ...body, channelId: "general" }],
		["a message over the limit", { ...body, message: "x".repeat(201) }],
		["a body that is not an object", "Rss"],
	])("refuses %s", async (_name, invalid) => {
		const answer = await call(AddRoute, { body: invalid });

		expect(answer).toEqual({ status: 400, body: { error: "invalid-body" } });
		expect(prismaMock.guildSocialSubscription.create).not.toHaveBeenCalled();
	});

	it("leaves a connected account to the command that connects it", async () => {
		const answer = await call(AddRoute, {
			body: { ...body, provider: "Instagram" },
		});

		expect(answer).toEqual({
			status: 422,
			body: { error: "provider-not-manageable" },
		});
		expect(prismaMock.guildSocialSubscription.create).not.toHaveBeenCalled();
	});

	it("refuses a channel of another guild", async () => {
		apiMock.guilds.getChannels.mockResolvedValue([]);

		const answer = await call(AddRoute, { body });

		expect(answer).toEqual({
			status: 422,
			body: { error: "channel-not-found" },
		});
		expect(prismaMock.guildSocialSubscription.create).not.toHaveBeenCalled();
	});

	it("refuses a channel the bot cannot post in", async () => {
		apiMock.guilds.getMember.mockResolvedValue({ roles: [] });

		const answer = await call(AddRoute, { body });

		expect(answer).toEqual({
			status: 422,
			body: { error: "missing-permissions" },
		});
	});

	it("refuses a channel that is neither text nor announcement", async () => {
		allowPosting({ type: 2 });

		const answer = await call(AddRoute, { body });

		expect(answer).toEqual({
			status: 422,
			body: { error: "channel-not-supported" },
		});
	});

	it("counts only the provider being added against its limit", async () => {
		prismaMock.guildSocialSubscription.count.mockResolvedValue(24);

		const answer = await call(AddRoute, { body });

		expect(answer.status).toBe(201);
		expect(prismaMock.guildSocialSubscription.count).toHaveBeenCalledWith({
			where: { guildId: BigInt(GuildId), source: { provider: "Rss" } },
		});
	});

	it("answers a conflict for a target the channel already follows", async () => {
		prismaMock.guildSocialSubscription.findFirst.mockResolvedValue({});

		const answer = await call(AddRoute, { body });

		expect(answer).toEqual({ status: 409, body: { error: "duplicate" } });
	});

	it("names the limit once the guild follows as many of the provider as it may", async () => {
		prismaMock.guildSocialSubscription.count.mockResolvedValue(25);

		const answer = await call(AddRoute, { body });

		expect(answer).toEqual({ status: 422, body: { error: "limit-reached" } });
	});
});

describe("DELETE /guilds/:guild/subscriptions/:channel/:source", () => {
	const params = { channel: ChannelId, source: "5" };

	it("removes the subscription and answers with what is left", async () => {
		prismaMock.guildSocialSubscription.findUnique.mockResolvedValue(
			makeSubscription(),
		);

		const answer = await call(RemoveRoute, { params });

		expect(answer).toMatchObject({
			status: 200,
			body: {
				removed: { sourceId: "5", displayName: "Example feed" },
				subscriptions: [],
			},
		});
		expect(prismaMock.guildSocialSubscription.delete).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					guildId_channelId_sourceId: {
						guildId: BigInt(GuildId),
						channelId: BigInt(ChannelId),
						sourceId: 5n,
					},
				},
			}),
		);
	});

	it("still answers 200 when the list cannot be read after the removal", async () => {
		prismaMock.guildSocialSubscription.findUnique.mockResolvedValue(
			makeSubscription(),
		);
		prismaMock.guildSocialSubscription.findMany.mockRejectedValue(
			new Error("connection lost"),
		);

		const answer = await call(RemoveRoute, { params });

		expect(answer).toMatchObject({
			status: 200,
			body: { removed: { sourceId: "5" }, subscriptions: null },
		});
	});

	it("answers 404 for a subscription the guild does not have", async () => {
		const answer = await call(RemoveRoute, { params });

		expect(answer).toEqual({
			status: 404,
			body: { error: "subscription-not-found" },
		});
		expect(prismaMock.guildSocialSubscription.delete).not.toHaveBeenCalled();
	});

	it("keeps the subscription of a connected account", async () => {
		prismaMock.guildSocialSubscription.findUnique.mockResolvedValue(
			makeSubscription({
				source: { ...makeSubscription().source, provider: "TikTok" },
			}),
		);

		const answer = await call(RemoveRoute, { params });

		expect(answer).toEqual({
			status: 422,
			body: { error: "provider-not-manageable" },
		});
		expect(prismaMock.guildSocialSubscription.delete).not.toHaveBeenCalled();
	});

	it("refuses a source that is not an id", async () => {
		const answer = await call(RemoveRoute, {
			params: { channel: ChannelId, source: "feed" },
		});

		expect(answer).toEqual({
			status: 400,
			body: { error: "invalid-subscription" },
		});
	});
});

const liveRow = (overrides: Record<string, unknown> = {}) => ({
	guildId: BigInt(GuildId),
	channelId: BigInt(ChannelId),
	message: null,
	subscriptionId: 7n,
	twitchSubscription: {
		id: 7n,
		streamerId: "123",
		subscriptionId: "eventsub-1",
		subscriptionType: "StreamOnline",
		revokedReason: null,
	},
	...overrides,
});

describe("POST /guilds/:guild/twitch", () => {
	const body = {
		streamer: "CoolStreamer",
		channelId: ChannelId,
		type: "StreamOnline",
	};

	it("follows the streamer through EventSub and answers with the new subscription", async () => {
		prismaMock.guildSubscription.findMany
			.mockResolvedValueOnce([])
			.mockResolvedValue([liveRow()]);

		const answer = await call(TwitchAddRoute, {
			body: { ...body, streamer: "@coolstreamer" },
		});

		expect(answer.status).toBe(201);
		expect(answer.body).toMatchObject({
			subscription: {
				subscriptionId: "7",
				streamerId: "123",
				type: "StreamOnline",
			},
			twitch: [{ subscriptionId: "7", streamerName: "CoolStreamer" }],
		});
		expect(fetchUsers).toHaveBeenCalledWith({ logins: ["coolstreamer"] });
		expect(addEventSubscription).toHaveBeenCalledOnce();
		expect(prismaMock.guildSubscription.create).toHaveBeenCalledOnce();
	});

	it("joins the streamer's existing subscription without asking Twitch again", async () => {
		prismaMock.twitchSubscription.findFirst.mockResolvedValue(
			liveRow().twitchSubscription,
		);

		const answer = await call(TwitchAddRoute, { body });

		expect(answer.status).toBe(201);
		expect(addEventSubscription).not.toHaveBeenCalled();
	});

	it("refuses a sixteenth Twitch live notification, before asking Twitch", async () => {
		prismaMock.guildSubscription.count.mockResolvedValue(15);

		const answer = await call(TwitchAddRoute, { body });

		expect(answer).toEqual({ status: 422, body: { error: "limit-reached" } });
		expect(addEventSubscription).not.toHaveBeenCalled();
		expect(fetchUsers).not.toHaveBeenCalled();
	});

	// The first count lets it through; another add takes the last place before the insert.
	it("refuses when a parallel add took the last place, joining an existing streamer", async () => {
		prismaMock.twitchSubscription.findFirst.mockResolvedValue(
			liveRow().twitchSubscription,
		);
		prismaMock.guildSubscription.count
			.mockResolvedValueOnce(14)
			.mockResolvedValueOnce(15);

		const answer = await call(TwitchAddRoute, { body });

		expect(answer).toEqual({ status: 422, body: { error: "limit-reached" } });
		expect(prismaMock.guildSubscription.create).not.toHaveBeenCalled();
		expect(prismaMock.$queryRaw).toHaveBeenCalled();
	});

	it("removes the EventSub subscription it made when a parallel add took the last place", async () => {
		prismaMock.guildSubscription.count
			.mockResolvedValueOnce(14)
			.mockResolvedValueOnce(15);

		const answer = await call(TwitchAddRoute, { body });

		expect(answer).toEqual({ status: 422, body: { error: "limit-reached" } });
		expect(addEventSubscription).toHaveBeenCalledOnce();
		expect(removeEventSubscription).toHaveBeenCalledWith("eventsub-1");
		expect(prismaMock.guildSubscription.create).not.toHaveBeenCalled();
	});

	it("allows more Twitch live notifications to a guild Ring raised", async () => {
		vi.stubEnv("INTERNAL_RING_URL", "https://ring.test/guilds");
		vi.stubEnv("INTERNAL_RING_TOKEN", "ring-token");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ maximumTwitchSubscriptions: 25 })),
		);
		prismaMock.guildSubscription.count.mockResolvedValue(15);

		const answer = await call(TwitchAddRoute, { body });

		vi.unstubAllGlobals();
		expect(answer.status).toBe(201);
	});

	it("asks for a message before an offline notification, as the command does", async () => {
		const answer = await call(TwitchAddRoute, {
			body: { ...body, type: "StreamOffline" },
		});

		expect(answer).toEqual({
			status: 422,
			body: { error: "message-required" },
		});
		expect(prismaMock.guildSubscription.create).not.toHaveBeenCalled();
	});

	// The member would otherwise be told to check a spelling that is right.
	it("names Twitch, not the streamer, when Twitch cannot be asked", async () => {
		vi.mocked(fetchUsers).mockRejectedValue(new Error("Twitch is down"));

		const answer = await call(TwitchAddRoute, { body });

		expect(answer).toEqual({ status: 422, body: { error: "twitch-failed" } });
		expect(prismaMock.guildSubscription.create).not.toHaveBeenCalled();
	});

	it("says Twitch has no such streamer", async () => {
		vi.mocked(fetchUsers).mockResolvedValue({ data: [] } as never);

		const answer = await call(TwitchAddRoute, { body });

		expect(answer).toEqual({
			status: 422,
			body: { error: "streamer-not-found" },
		});
	});

	it("answers a conflict for a streamer the channel already follows for that event", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([liveRow()]);

		const answer = await call(TwitchAddRoute, { body });

		expect(answer).toEqual({ status: 409, body: { error: "duplicate" } });
	});

	it("names Twitch, not Staryl, when Twitch refuses the EventSub subscription", async () => {
		vi.mocked(addEventSubscription).mockRejectedValue(
			new Error("409 Conflict"),
		);

		const answer = await call(TwitchAddRoute, { body });

		expect(answer).toEqual({ status: 422, body: { error: "twitch-failed" } });
	});

	it("refuses before anything else when the bot cannot look a streamer up", async () => {
		vi.mocked(areTwitchClientCredentialsSet).mockReturnValue(false);

		const answer = await call(TwitchAddRoute, { body });

		expect(answer).toEqual({
			status: 422,
			body: { error: "provider-not-configured" },
		});
		expect(fetchUsers).not.toHaveBeenCalled();
	});

	// Joining a streamer another channel follows asks nothing of EventSub.
	it("still joins a followed streamer when the bot has no EventSub credentials", async () => {
		vi.mocked(areTwitchEventSubCredentialsSet).mockReturnValue(false);
		prismaMock.twitchSubscription.findFirst.mockResolvedValue(
			liveRow().twitchSubscription,
		);

		const answer = await call(TwitchAddRoute, { body });

		expect(answer.status).toBe(201);
	});

	it("answers that Twitch failed for a new streamer when the bot has no EventSub credentials", async () => {
		vi.mocked(areTwitchEventSubCredentialsSet).mockReturnValue(false);

		const answer = await call(TwitchAddRoute, { body });

		expect(answer).toEqual({ status: 422, body: { error: "twitch-failed" } });
	});

	it("refuses a channel the bot cannot post in", async () => {
		apiMock.guilds.getMember.mockResolvedValue({ roles: [] });

		const answer = await call(TwitchAddRoute, { body });

		expect(answer).toEqual({
			status: 422,
			body: { error: "missing-permissions" },
		});
		expect(fetchUsers).not.toHaveBeenCalled();
	});

	it.each([
		["a login with a space", { ...body, streamer: "cool streamer" }],
		["an unknown event", { ...body, type: "StreamRaid" }],
		["a channel that is not an id", { ...body, channelId: "general" }],
		["a message over the limit", { ...body, message: "x".repeat(201) }],
	])("refuses %s", async (_name, invalid) => {
		const answer = await call(TwitchAddRoute, { body: invalid });

		expect(answer).toEqual({ status: 400, body: { error: "invalid-body" } });
	});
});

describe("DELETE /guilds/:guild/twitch/:channel/:subscription", () => {
	const params = { channel: ChannelId, subscription: "7" };

	it("removes the channel's row, and the EventSub subscription nobody else uses", async () => {
		prismaMock.guildSubscription.findUnique.mockResolvedValue(liveRow());
		prismaMock.twitchSubscription.findFirst.mockResolvedValue({
			...liveRow().twitchSubscription,
			guildSubscription: [],
		});

		const answer = await call(TwitchRemoveRoute, { params });

		expect(answer).toMatchObject({
			status: 200,
			body: {
				removed: {
					subscriptionId: "7",
					streamerName: "CoolStreamer",
					type: "StreamOnline",
				},
				twitch: [],
			},
		});
		expect(prismaMock.guildSubscription.delete).toHaveBeenCalledOnce();
		expect(removeEventSubscription).toHaveBeenCalledWith("eventsub-1");
	});

	it("keeps the EventSub subscription another channel still uses", async () => {
		prismaMock.guildSubscription.findUnique.mockResolvedValue(liveRow());
		prismaMock.twitchSubscription.findFirst.mockResolvedValue({
			...liveRow().twitchSubscription,
			guildSubscription: [liveRow({ channelId: 9n })],
		});

		await call(TwitchRemoveRoute, { params });

		expect(removeEventSubscription).not.toHaveBeenCalled();
	});

	it("still answers 200 when Twitch fails the cleanup after the removal", async () => {
		prismaMock.guildSubscription.findUnique.mockResolvedValue(liveRow());
		prismaMock.twitchSubscription.findFirst.mockResolvedValue({
			...liveRow().twitchSubscription,
			guildSubscription: [],
		});
		vi.mocked(removeEventSubscription).mockRejectedValue(
			new Error("Twitch is down"),
		);

		const answer = await call(TwitchRemoveRoute, { params });

		expect(answer.status).toBe(200);
	});

	it("answers 404 for a subscription the guild does not have", async () => {
		const answer = await call(TwitchRemoveRoute, { params });

		expect(answer).toEqual({
			status: 404,
			body: { error: "subscription-not-found" },
		});
		expect(prismaMock.guildSubscription.delete).not.toHaveBeenCalled();
	});

	it("refuses a subscription that is not an id", async () => {
		const answer = await call(TwitchRemoveRoute, {
			params: { channel: ChannelId, subscription: "../7" },
		});

		expect(answer).toEqual({
			status: 400,
			body: { error: "invalid-subscription" },
		});
	});
});

const OtherChannelId = "800000000000000002";

/** The guild has a second channel the bot may post in. */
function allowSecondChannel() {
	apiMock.guilds.getChannels.mockResolvedValue([
		{ id: ChannelId, name: "general", type: 0, guild_id: GuildId },
		{ id: OtherChannelId, name: "news", type: 0, guild_id: GuildId },
	]);
}

/** What Prisma throws for a unique key that is taken, or a row that is gone. */
const prismaError = (code: string) => Object.assign(new Error(code), { code });

describe("PATCH /guilds/:guild/subscriptions/:channel/:source", () => {
	const params = { channel: ChannelId, source: "5" };

	it("moves the subscription, keeping its filters and clearing the old channel's error", async () => {
		allowSecondChannel();
		const previous = makeSubscription({
			filters: { keywords: ["release"] },
			deliveryError: "MissingPermissions",
		});
		prismaMock.guildSocialSubscription.findUnique.mockResolvedValue(previous);
		prismaMock.guildSocialSubscription.update.mockResolvedValue({
			...previous,
			channelId: BigInt(OtherChannelId),
			deliveryError: null,
		});

		const answer = await call(EditRoute, {
			params,
			body: { channelId: OtherChannelId },
		});

		expect(answer).toMatchObject({
			status: 200,
			body: {
				previous: { channelId: ChannelId, deliveryError: "MissingPermissions" },
				subscription: { channelId: OtherChannelId, deliveryError: null },
				subscriptions: [],
			},
		});
		expect(prismaMock.guildSocialSubscription.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { channelId: BigInt(OtherChannelId), deliveryError: null },
			}),
		);
	});

	it("changes the message without checking the channel again", async () => {
		prismaMock.guildSocialSubscription.findUnique.mockResolvedValue(
			makeSubscription({ message: "Old" }),
		);
		prismaMock.guildSocialSubscription.update.mockResolvedValue(
			makeSubscription({ message: "New post!" }),
		);

		const answer = await call(EditRoute, {
			params,
			body: { channelId: ChannelId, message: "  New post!  " },
		});

		expect(answer).toMatchObject({
			status: 200,
			body: {
				previous: { message: "Old" },
				subscription: { message: "New post!" },
			},
		});
		expect(prismaMock.guildSocialSubscription.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: { message: "New post!" } }),
		);
		expect(apiMock.guilds.getChannels).not.toHaveBeenCalled();
	});

	it("removes the message when it is sent empty", async () => {
		prismaMock.guildSocialSubscription.findUnique.mockResolvedValue(
			makeSubscription({ message: "Old" }),
		);
		prismaMock.guildSocialSubscription.update.mockResolvedValue(
			makeSubscription(),
		);

		await call(EditRoute, { params, body: { message: "" } });

		expect(prismaMock.guildSocialSubscription.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: { message: null } }),
		);
	});

	it("refuses a body that changes nothing", async () => {
		const answer = await call(EditRoute, { params, body: {} });

		expect(answer).toEqual({ status: 400, body: { error: "invalid-body" } });
	});

	it("refuses to move the subscription to a channel of another guild", async () => {
		prismaMock.guildSocialSubscription.findUnique.mockResolvedValue(
			makeSubscription(),
		);

		const answer = await call(EditRoute, {
			params,
			body: { channelId: OtherChannelId },
		});

		expect(answer).toEqual({
			status: 422,
			body: { error: "channel-not-found" },
		});
		expect(prismaMock.guildSocialSubscription.update).not.toHaveBeenCalled();
	});

	it("answers a conflict when the new channel already follows the source", async () => {
		allowSecondChannel();
		prismaMock.guildSocialSubscription.findUnique.mockResolvedValue(
			makeSubscription(),
		);
		prismaMock.guildSocialSubscription.update.mockRejectedValue(
			prismaError("P2002"),
		);

		const answer = await call(EditRoute, {
			params,
			body: { channelId: OtherChannelId },
		});

		expect(answer).toEqual({ status: 409, body: { error: "duplicate" } });
	});

	it("answers 404 when the subscription went away before the write", async () => {
		prismaMock.guildSocialSubscription.findUnique.mockResolvedValue(
			makeSubscription(),
		);
		prismaMock.guildSocialSubscription.update.mockRejectedValue(
			prismaError("P2025"),
		);

		const answer = await call(EditRoute, { params, body: { message: "Hi" } });

		expect(answer).toEqual({
			status: 404,
			body: { error: "subscription-not-found" },
		});
	});

	it("keeps the subscription of a connected account", async () => {
		prismaMock.guildSocialSubscription.findUnique.mockResolvedValue(
			makeSubscription({
				source: { ...makeSubscription().source, provider: "TikTok" },
			}),
		);

		const answer = await call(EditRoute, { params, body: { message: "Hi" } });

		expect(answer).toEqual({
			status: 422,
			body: { error: "provider-not-manageable" },
		});
	});

	it("answers 404 for a subscription the guild does not have", async () => {
		const answer = await call(EditRoute, { params, body: { message: "Hi" } });

		expect(answer).toEqual({
			status: 404,
			body: { error: "subscription-not-found" },
		});
	});
});

describe("PATCH /guilds/:guild/twitch/:channel/:subscription", () => {
	const params = { channel: ChannelId, subscription: "7" };

	it("moves the notification and changes its message", async () => {
		allowSecondChannel();
		prismaMock.guildSubscription.findUnique.mockResolvedValue(liveRow());
		prismaMock.guildSubscription.update.mockResolvedValue(
			liveRow({ channelId: BigInt(OtherChannelId), message: "Live now!" }),
		);

		const answer = await call(TwitchEditRoute, {
			params,
			body: { channelId: OtherChannelId, message: "Live now!" },
		});

		expect(answer).toMatchObject({
			status: 200,
			body: {
				previous: { channelId: ChannelId, message: null },
				subscription: {
					subscriptionId: "7",
					streamerName: "CoolStreamer",
					channelId: OtherChannelId,
					message: "Live now!",
				},
				twitch: [],
			},
		});
		expect(prismaMock.guildSubscription.update).toHaveBeenCalledWith({
			where: {
				guildId_channelId_subscriptionId: {
					guildId: BigInt(GuildId),
					channelId: BigInt(ChannelId),
					subscriptionId: 7n,
				},
			},
			data: { channelId: BigInt(OtherChannelId), message: "Live now!" },
		});
	});

	it("keeps the message of an end-of-stream notification", async () => {
		prismaMock.guildSubscription.findUnique.mockResolvedValue(
			liveRow({
				message: "Thanks for watching",
				twitchSubscription: {
					...liveRow().twitchSubscription,
					subscriptionType: "StreamOffline",
				},
			}),
		);

		const answer = await call(TwitchEditRoute, {
			params,
			body: { message: "" },
		});

		expect(answer).toEqual({
			status: 422,
			body: { error: "message-required" },
		});
		expect(prismaMock.guildSubscription.update).not.toHaveBeenCalled();
	});

	it("answers a conflict when the new channel already has the notification", async () => {
		allowSecondChannel();
		prismaMock.guildSubscription.findUnique.mockResolvedValue(liveRow());
		prismaMock.guildSubscription.update.mockRejectedValue(prismaError("P2002"));

		const answer = await call(TwitchEditRoute, {
			params,
			body: { channelId: OtherChannelId },
		});

		expect(answer).toEqual({ status: 409, body: { error: "duplicate" } });
	});

	it("answers 404 for a notification the guild does not have", async () => {
		const answer = await call(TwitchEditRoute, {
			params,
			body: { message: "Hi" },
		});

		expect(answer).toEqual({
			status: 404,
			body: { error: "subscription-not-found" },
		});
	});
});
