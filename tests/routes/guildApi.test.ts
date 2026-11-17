import type { ApiRequest, ApiResponse, Route } from "@wolfstar/plugin-api";
import { readFileSync } from "node:fs";
import { DiscordAPIError } from "@discordjs/rest";
import { ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { fetchUsers } from "@wolfstar/twitch-helpers";
import { PermissionFlagsBits } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserRoute as GetRoute } from "../../src/routes/guilds/[guild]/notifications.get.ts";
import { UserRoute as PatchRoute } from "../../src/routes/guilds/[guild]/notifications.patch.ts";
import { UserRoute as AddRoute } from "../../src/routes/guilds/[guild]/subscriptions.post.ts";
import { UserRoute as RemoveRoute } from "../../src/routes/guilds/[guild]/subscriptions/[channel]/[source].delete.ts";

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
	return { ...actual, fetchUsers: vi.fn() };
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
	guild: { findUnique: vi.fn(), upsert: vi.fn() },
	guildSubscription: { findMany: vi.fn() },
	guildSocialSubscription: {
		count: vi.fn(),
		create: vi.fn(),
		delete: vi.fn(),
		findFirst: vi.fn(),
		findMany: vi.fn(),
		findUnique: vi.fn(),
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

	it("answers a conflict for a target the channel already follows", async () => {
		prismaMock.guildSocialSubscription.findFirst.mockResolvedValue({});

		const answer = await call(AddRoute, { body });

		expect(answer).toEqual({ status: 409, body: { error: "duplicate" } });
	});

	it("names the limit once the guild follows as many as it may", async () => {
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
