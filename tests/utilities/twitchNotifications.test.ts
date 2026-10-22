import type { TwitchEventSubOnlineEvent } from "@wolfstar/twitch-helpers";
import {
	NotificationDeliveryError,
	sendOfflineNotification,
	sendOnlineNotification,
} from "#twitch/notifications";
import { container as piece } from "@wolfstar/http-framework";
import { TwitchBrandingColor } from "@wolfstar/twitch-helpers";
import {
	ButtonStyle,
	MessageFlags,
	PermissionFlagsBits,
} from "discord-api-types/v10";
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
const BotRoleId = "900000000000000001";

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

function grantPermissions(
	permissions: string,
	overwrites: { allow: string; deny: string; id: string; type: number }[] = [],
) {
	apiMock.guilds.get.mockResolvedValue({
		preferred_locale: "en-US",
		roles: [
			{ id: String(GuildId), permissions: "0" },
			{ id: BotRoleId, permissions },
		],
	});
	apiMock.guilds.getChannels.mockResolvedValue([
		{
			id: String(ChannelId),
			name: "general",
			type: 0,
			guild_id: String(GuildId),
			permission_overwrites: overwrites,
		},
	]);
	apiMock.users.getCurrent.mockResolvedValue({ id: "bot-id" });
	apiMock.guilds.getMember.mockResolvedValue({ roles: [BotRoleId] });
	apiMock.channels.createMessage.mockResolvedValue({ id: "1" });
}

interface SentComponent {
	type: number;
	content?: string;
	accent_color?: number;
	components?: SentComponent[];
	accessory?: { media: { url: string } };
	items?: { media: { url: string } }[];
	url?: string;
	label?: string;
	style?: number;
}

const ComponentType = {
	ActionRow: 1,
	Button: 2,
	Section: 9,
	TextDisplay: 10,
	MediaGallery: 12,
	Container: 17,
} as const;

function sentBody() {
	const [, body] = apiMock.channels.createMessage.mock.calls[0]!;
	return body as {
		content?: string;
		flags?: number;
		components?: SentComponent[];
		allowed_mentions: { parse: string[]; users: string[]; roles: string[] };
	};
}

function container() {
	return sentBody().components!.find(
		(component) => component.type === ComponentType.Container,
	)!;
}

/** Every text display of the notification, joined, wherever it is nested. */
function sentText() {
	const texts: string[] = [];
	const visit = (components: SentComponent[] = []) => {
		for (const component of components) {
			if (component.type === ComponentType.TextDisplay) {
				texts.push(component.content!);
			}
			visit(component.components);
		}
	};
	visit(sentBody().components);
	return texts.join("\n");
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(piece.logger, "error").mockImplementation(() => {
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
		// Components V2 messages cannot carry `content`: the stored message leads as a text display.
		expect(body.flags).toBe(MessageFlags.IsComponentsV2);
		expect(body.content).toBeUndefined();
		expect(body.components?.[0]).toMatchObject({
			type: ComponentType.TextDisplay,
			content: "Hey @everyone!",
		});

		expect(container().accent_color).toBe(TwitchBrandingColor);
		const text = sentText();
		expect(text).toContain(`**${StreamerName} is now live on Twitch!**`);
		expect(text).toContain(
			`### [A great stream](https://twitch.tv/${StreamerName.toLowerCase()})`,
		);
		expect(text).toContain("**Game**\nJust Chatting");
		expect(text).toContain("Staryl Twitch Notifications");

		// `{width}`/`{height}` must be substituted or Discord rejects the URL.
		const section = container().components!.find(
			(component) => component.type === ComponentType.Section,
		);
		expect(section?.accessory?.media.url).toBe(
			"https://cdn.twitch.tv/box-128x128.png",
		);

		const gallery = container().components!.find(
			(component) => component.type === ComponentType.MediaGallery,
		);
		expect(gallery?.items?.[0]?.media.url).toMatch(
			/^https:\/\/static-cdn\.jtvnw\.net\/previews-ttv\/live_user_coolstreamer-0x0\.jpg\?t=\d+$/,
		);

		const row = body.components?.find(
			(component) => component.type === ComponentType.ActionRow,
		);
		expect(row?.components?.[0]).toMatchObject({
			type: ComponentType.Button,
			style: ButtonStyle.Link,
			label: "Watch Stream",
			url: "https://twitch.tv/coolstreamer",
		});
	});

	it("leads with the container when there is no custom message", async () => {
		await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: null,
			event: onlineEvent,
			streamData: streamData(),
		});

		expect(sentBody().components?.[0]?.type).toBe(ComponentType.Container);
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

	it("applies a channel overwrite to the bot's roles", async () => {
		grantPermissions(FullPermissions, [
			{
				allow: "0",
				deny: String(PermissionFlagsBits.SendMessages),
				id: BotRoleId,
				type: 0,
			},
		]);

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

	it("lets an administrator bypass denied channel permissions", async () => {
		grantPermissions(String(PermissionFlagsBits.Administrator), [
			{
				allow: "0",
				deny: String(
					PermissionFlagsBits.ViewChannel |
						PermissionFlagsBits.SendMessages |
						PermissionFlagsBits.EmbedLinks,
				),
				id: BotRoleId,
				type: 0,
			},
		]);

		const result = await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: null,
			event: onlineEvent,
			streamData: streamData(),
		});

		expect(result.isOk()).toBe(true);
		expect(apiMock.channels.createMessage).toHaveBeenCalledOnce();
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
		apiMock.guilds.get.mockResolvedValue({
			preferred_locale: "de",
			roles: [
				{ id: String(GuildId), permissions: "0" },
				{ id: BotRoleId, permissions: FullPermissions },
			],
		});

		const result = await sendOnlineNotification({
			guildId: GuildId,
			channelId: ChannelId,
			message: null,
			event: onlineEvent,
			streamData: streamData(),
		});

		expect(result.isOk()).toBe(true);
		expect(sentText()).toContain("**Game**\nJust Chatting");
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

		expect(sentBody().components?.[0]).toMatchObject({
			type: ComponentType.TextDisplay,
			content:
				"🧪 **Test notification** — this is a preview requested by a server administrator, not a real stream update.\nHey!",
		});
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

		const text = sentText();
		expect(text).toContain("### [Test notification](");
		expect(text).not.toContain("**Game**");
		// No stream means no preview frame and no box art to show.
		expect(
			container().components?.some(
				(component) =>
					component.type === ComponentType.MediaGallery ||
					component.type === ComponentType.Section,
			),
		).toBe(false);
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

		// The streamer's name stands in for the missing title instead of rendering a bare link.
		expect(sentText()).toContain(
			`### [${StreamerName}](https://twitch.tv/coolstreamer)`,
		);
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
