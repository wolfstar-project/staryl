import type { TwitchEventSubOnlineEvent } from "@wolfstar/twitch-helpers";
import {
	NotificationDeliveryError,
	sendOfflineNotification,
	sendOnlineNotification,
} from "#utils/twitchNotifications";
import { container } from "@wolfstar/http-framework";
import { PermissionFlagsBits } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
	guilds: {
		get: vi.fn(),
		getChannels: vi.fn(),
		getMember: vi.fn(),
	},
	channels: { createMessage: vi.fn() },
	users: { getCurrent: vi.fn() },
}));

vi.mock("#utils/discordApi", () => ({ api: () => apiMock }));

const GuildId = 737141877803057244n;
const ChannelId = 800000000000000001n;
const StreamerName = "CoolStreamer";

const FullPermissions = String(
	PermissionFlagsBits.ViewChannel |
		PermissionFlagsBits.SendMessages |
		PermissionFlagsBits.EmbedLinks,
);
const NoEmbedPermissions = String(
	PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
);

const onlineEvent: TwitchEventSubOnlineEvent = {
	broadcaster_user_id: "123456789",
	broadcaster_user_login: "coolstreamer",
	broadcaster_user_name: StreamerName,
	id: "0",
	type: "live",
	started_at: "2026-08-07T12:00:00.000Z",
};

function streamData(overrides: Record<string, unknown> = {}) {
	return {
		game_name: "Just Chatting",
		game_box_art_url: "https://cdn.twitch.tv/box-{width}x{height}.png",
		thumbnail_url: "https://cdn.twitch.tv/thumb-{width}x{height}.png",
		language: "en",
		started_at: new Date("2026-08-07T12:00:00.000Z"),
		title: "A great stream",
		viewer_count: 42,
		...overrides,
	} as never;
}

function grantPermissions(permissions: string) {
	apiMock.guilds.get.mockResolvedValue({ preferred_locale: "en-US" });
	apiMock.guilds.getChannels.mockResolvedValue([
		{
			id: String(ChannelId),
			name: "general",
			type: 0,
			guild_id: String(GuildId),
		},
	]);
	apiMock.users.getCurrent.mockResolvedValue({ id: "bot-id" });
	apiMock.guilds.getMember.mockResolvedValue({ permissions });
	apiMock.channels.createMessage.mockResolvedValue({ id: "1" });
}

function sentBody() {
	const [, body] = apiMock.channels.createMessage.mock.calls[0]!;
	return body as {
		content?: string;
		embeds?: {
			title?: string;
			description?: string;
			image?: { url: string };
		}[];
		allowed_mentions: { parse: string[]; users: string[]; roles: string[] };
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(container.logger, "error").mockImplementation(() => {
		// noop
	});
	grantPermissions(FullPermissions);
});

describe("sendOnlineNotification", () => {
	it("posts the embed and the custom message", async () => {
		const result = await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: "Hey @everyone!",
			event: onlineEvent,
			streamData: streamData(),
		});

		expect(result.isOk()).toBe(true);
		expect(apiMock.channels.createMessage).toHaveBeenCalledWith(
			String(ChannelId),
			expect.anything(),
		);

		const body = sentBody();
		expect(body.content).toBe("Hey @everyone!");
		expect(body.embeds?.[0]?.title).toBe("A great stream");
		expect(body.embeds?.[0]?.description).toBe(
			`${StreamerName} is now live - Streaming Just Chatting!`,
		);
		// `{width}`/`{height}` must be substituted or Discord rejects the URL.
		expect(body.embeds?.[0]?.image?.url).toBe(
			"https://cdn.twitch.tv/thumb-128x128.png",
		);
	});

	it("refuses to deliver when the bot cannot embed links", async () => {
		// Regression: the listeners negated the *promise* returned by `canSendEmbeds`, which is always
		// truthy, so this gate never rejected anything and the send failed against Discord instead.
		grantPermissions(NoEmbedPermissions);

		const result = await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: null,
			event: onlineEvent,
			streamData: streamData(),
		});

		expect(result.unwrapErr()).toBe(
			NotificationDeliveryError.MissingPermissions,
		);
		expect(apiMock.channels.createMessage).not.toHaveBeenCalled();
	});

	it("reports a missing channel", async () => {
		apiMock.guilds.getChannels.mockResolvedValue([]);

		const result = await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: null,
			event: onlineEvent,
			streamData: streamData(),
		});

		expect(result.unwrapErr()).toBe(NotificationDeliveryError.ChannelNotFound);
	});

	it("falls back to en-US when the guild locale is not loaded", async () => {
		// Regression: `getT` throws `ReferenceError: Invalid language (de)` for locales the bot has
		// not loaded, which escaped the `Result` error path and aborted the delivery entirely.
		apiMock.guilds.get.mockResolvedValue({ preferred_locale: "de" });

		const result = await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: null,
			event: onlineEvent,
			streamData: streamData(),
		});

		expect(result.isOk()).toBe(true);
		expect(sentBody().embeds?.[0]?.description).toBe(
			`${StreamerName} is now live - Streaming Just Chatting!`,
		);
	});

	it("reports an unreachable guild", async () => {
		apiMock.guilds.get.mockRejectedValue(new Error("404"));

		const result = await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: null,
			event: onlineEvent,
			streamData: streamData(),
		});

		expect(result.unwrapErr()).toBe(NotificationDeliveryError.GuildUnavailable);
	});

	it("reports a rejected send instead of throwing", async () => {
		apiMock.channels.createMessage.mockRejectedValue(new Error("403"));

		const result = await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: null,
			event: onlineEvent,
			streamData: streamData(),
		});

		expect(result.unwrapErr()).toBe(NotificationDeliveryError.SendFailed);
	});

	it("prepends the test notice and keeps the stored message", async () => {
		await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: "Hey!",
			event: onlineEvent,
			streamData: streamData(),
			testNotice: true,
		});

		const body = sentBody();
		expect(body.content).toBe(
			"🧪 **Test notification** — this is a preview requested by a server administrator, not a real stream update.\nHey!",
		);
	});

	it("uses a placeholder title when testing a streamer that is not live", async () => {
		await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: null,
			event: onlineEvent,
			streamData: null,
			testNotice: true,
		});

		const body = sentBody();
		expect(body.embeds?.[0]?.title).toBe("Test notification");
		expect(body.embeds?.[0]?.description).toBe(`${StreamerName} is now live!`);
	});

	it("keeps the empty title for a real notification without stream data", async () => {
		// Only the test path substitutes the placeholder; a real notification racing ahead of Twitch's
		// stream data must behave exactly as before.
		await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: null,
			event: onlineEvent,
			streamData: null,
		});

		expect(sentBody().embeds?.[0]?.title).toBeUndefined();
	});

	it("does not let the test notice widen allowed_mentions", async () => {
		await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: null,
			event: onlineEvent,
			streamData: streamData(),
			testNotice: true,
		});

		expect(sentBody().allowed_mentions).toEqual({
			parse: [],
			users: [],
			roles: [],
		});
	});
});

describe("sendOfflineNotification", () => {
	it("posts the stored message with the timestamp and the postfix", async () => {
		const date = new Date("2026-08-07T12:00:00.000Z");

		const result = await sendOfflineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: "Stream over!",
			date,
		});

		expect(result.isOk()).toBe(true);
		expect(sentBody().content).toBe(
			`Stream over! | <t:${Math.floor(date.getTime() / 1000)}:f> | Staryl Twitch Notifications`,
		);
	});

	it("only needs Send Messages, not Embed Links", async () => {
		grantPermissions(NoEmbedPermissions);

		const result = await sendOfflineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: "Stream over!",
			date: new Date(),
		});

		expect(result.isOk()).toBe(true);
	});
});
