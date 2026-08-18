import type { TFunction } from "@wolfstar/http-framework-i18n";
import type {
	TwitchEventSubOnlineEvent,
	TwitchHelixStreamsResult,
	TwitchOnlineEmbedData,
} from "@wolfstar/twitch-helpers";
import type {
	AllowedMentionsTypes,
	APIChannel,
	APIDMChannel,
	APIEmbed,
	APIGroupDMChannel,
	Locale,
} from "discord-api-types/v10";
import { LanguageKeys } from "#i18n";
import { api } from "#utils/discordApi";
import { canSendEmbeds, canSendMessages } from "#utils/discordUtilities";
import { extractDetailedMentions } from "#utils/util";
import {
	EmbedBuilder,
	escapeMarkdown,
	time,
	TimestampStyles,
} from "@discordjs/builders";
import { err, ok, Result } from "@sapphire/result";
import { cast, isNullish } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";
import { getT, loadedLocales } from "@wolfstar/http-framework-i18n";
import { TwitchBrandingColor } from "@wolfstar/twitch-helpers";

/**
 * The reason a notification could not be delivered.
 *
 * The `test` subcommand maps each of these onto a distinct message, which is the whole point of
 * returning a reason instead of a boolean: "the bot cannot post there" and "Discord rejected the
 * message" need different fixes from whoever ran the command.
 */
export enum NotificationDeliveryError {
	GuildUnavailable,
	ChannelNotFound,
	MissingPermissions,
	SendFailed,
}

export interface OnlineNotificationOptions {
	guildId: bigint;
	channelId: bigint;
	message: string | null;
	event: TwitchEventSubOnlineEvent;
	streamData: TwitchHelixStreamsResult | null;
	/**
	 * Prepends {@link LanguageKeys.Events.Twitch.TestNotice} to the content so the members of the
	 * channel do not read a manually triggered preview as the streamer actually going live, and
	 * substitutes a placeholder title when the streamer is not live and there is no stream to
	 * describe.
	 */
	testNotice?: boolean;
}

export interface OfflineNotificationOptions {
	guildId: bigint;
	channelId: bigint;
	message: string;
	date: Date;
	/** See {@link OnlineNotificationOptions.testNotice}. */
	testNotice?: boolean;
}

type GuildChannel = Exclude<APIChannel, APIDMChannel | APIGroupDMChannel>;

interface NotificationTarget {
	channel: GuildChannel;
	t: TFunction;
}

const kTwitchImageReplacerRegex = /(\{width\}|\{height\})/gi;

export async function sendOnlineNotification(
	options: OnlineNotificationOptions,
): Promise<Result<void, NotificationDeliveryError>> {
	container.logger.debug(
		`[twitch-notifications] sendOnlineNotification guild=${options.guildId} channel=${options.channelId} streamer=${options.event.broadcaster_user_login} startedAt=${options.event.started_at} hasStreamData=${!isNullish(options.streamData)} hasMessage=${!isNullish(options.message)} testNotice=${options.testNotice ?? false}`,
	);

	const targetResult = await resolveTarget(
		options.guildId,
		options.channelId,
		canSendEmbeds,
	);
	if (targetResult.isErr()) {
		container.logger.debug(
			`[twitch-notifications] sendOnlineNotification aborted for channel ${options.channelId}: ${NotificationDeliveryError[targetResult.unwrapErr()]}`,
		);
		return err(targetResult.unwrapErr());
	}

	const { channel, t } = targetResult.unwrap();
	const data = buildOnlineEmbedData(options.event, options.streamData);
	container.logger.debug(
		`[twitch-notifications] Online embed data for channel ${channel.id}: ${JSON.stringify(data)}`,
	);

	// A `test` on a streamer that is not live has no stream to describe, and `setTitle("")` renders
	// as a bare link. Only the test path substitutes it: a real notification that raced ahead of
	// Twitch's stream data must keep the original behaviour.
	if (options.testNotice && isNullish(options.streamData)) {
		data.title = t(LanguageKeys.Events.Twitch.TestPlaceholderTitle);
		container.logger.debug(
			`[twitch-notifications] No stream data for channel ${channel.id}, substituting the placeholder title`,
		);
	}

	// The custom message is optional for online subscriptions, the embed alone is already the
	// notification.
	return send(channel.id, options.message, options.testNotice, t, [
		buildOnlineEmbed(data, t),
	]);
}

export async function sendOfflineNotification(
	options: OfflineNotificationOptions,
): Promise<Result<void, NotificationDeliveryError>> {
	container.logger.debug(
		`[twitch-notifications] sendOfflineNotification guild=${options.guildId} channel=${options.channelId} date=${options.date.toISOString()} testNotice=${options.testNotice ?? false}`,
	);

	const targetResult = await resolveTarget(
		options.guildId,
		options.channelId,
		canSendMessages,
	);
	if (targetResult.isErr()) {
		container.logger.debug(
			`[twitch-notifications] sendOfflineNotification aborted for channel ${options.channelId}: ${NotificationDeliveryError[targetResult.unwrapErr()]}`,
		);
		return err(targetResult.unwrapErr());
	}

	const { channel, t } = targetResult.unwrap();
	const content = buildOfflineMessage(options.message, options.date, t);

	return send(channel.id, content, options.testNotice, t);
}

export function buildOnlineEmbedData(
	notification: TwitchEventSubOnlineEvent,
	streamData: TwitchHelixStreamsResult | null,
): TwitchOnlineEmbedData {
	return {
		embedThumbnailUrl: streamData?.game_box_art_url?.replace(
			kTwitchImageReplacerRegex,
			"128",
		),
		gameName: streamData?.game_name,
		language: streamData?.language,
		startedAt: new Date(notification.started_at),
		title: escapeText(streamData?.title),
		userName: notification.broadcaster_user_name,
		viewerCount: streamData?.viewer_count,
		embedImageUrl: streamData?.thumbnail_url.replace(
			kTwitchImageReplacerRegex,
			"128",
		),
	};
}

export function buildOnlineEmbed(
	data: TwitchOnlineEmbedData,
	t: TFunction,
): APIEmbed {
	const embed = new EmbedBuilder()
		.setURL(`https://twitch.tv/${data.userName}`)
		.setFooter({ text: t(LanguageKeys.Events.Twitch.OfflinePostfix) })
		.setColor(TwitchBrandingColor)
		.setTimestamp(data.startedAt);

	// `setTitle("")` throws: the builder rejects an empty string. `fetchStream` answers `null` when
	// Twitch has not published the stream yet — a routine race at go-live — which used to make the
	// whole notification blow up instead of arriving without a title.
	if (data.title) {
		embed.setTitle(data.title);
	}

	if (data.gameName) {
		embed.setDescription(
			t(LanguageKeys.Events.Twitch.EmbedDescriptionWithGame, {
				userName: data.userName,
				gameName: data.gameName,
			}),
		);
	} else {
		embed.setDescription(
			t(LanguageKeys.Events.Twitch.EmbedDescription, {
				userName: data.userName,
			}),
		);
	}

	if (data.embedImageUrl) {
		embed.setImage(data.embedImageUrl);
	}

	if (data.embedThumbnailUrl) {
		embed.setThumbnail(data.embedThumbnailUrl);
	}

	return embed.toJSON();
}

export function buildOfflineMessage(
	message: string,
	date: Date,
	t: TFunction,
): string {
	return `${message} | ${time(date, TimestampStyles.ShortDateTime)} | ${t(LanguageKeys.Events.Twitch.OfflinePostfix)}`;
}

export function escapeText(text?: string) {
	if (isNullish(text)) {
		return "";
	}

	return escapeMarkdown(text.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
}

/**
 * Resolves the guild's language and the channel to post in, refusing the delivery when the bot
 * cannot post there.
 *
 * `canSend` is awaited: both listeners used to negate the returned promise, which is always truthy,
 * so the permission gate never rejected anything and the send failed against Discord instead.
 */
async function resolveTarget(
	guildId: bigint,
	channelId: bigint,
	canSend: (channel: GuildChannel) => Promise<boolean>,
): Promise<Result<NotificationTarget, NotificationDeliveryError>> {
	const guildResult = await Result.fromAsync(() =>
		api().guilds.get(String(guildId)),
	);
	if (guildResult.isErr() || isNullish(guildResult.unwrap())) {
		container.logger.debug(
			`[twitch-notifications] Guild ${guildId} is unavailable`,
			guildResult.isErr() ? guildResult.unwrapErr() : undefined,
		);
		return err(NotificationDeliveryError.GuildUnavailable);
	}

	// `getT` throws when Discord reports a locale the bot has not loaded (e.g. `de` while only
	// `en-US` is bundled). An unsupported guild locale must degrade to the default language, not
	// escape `resolveTarget` and abort the delivery outside the `Result` error path.
	const preferredLocale = (guildResult.unwrap().preferred_locale ??
		"en-US") as Locale;
	const resolvedLocale = loadedLocales.has(preferredLocale)
		? preferredLocale
		: "en-US";
	container.logger.debug(
		`[twitch-notifications] Guild ${guildId} preferred locale ${preferredLocale}, resolved to ${resolvedLocale}`,
	);
	const t = getT(resolvedLocale);

	const channelsResult = await Result.fromAsync(() =>
		api().guilds.getChannels(String(guildId)),
	);
	if (channelsResult.isErr()) {
		container.logger.debug(
			`[twitch-notifications] Could not list the channels of guild ${guildId}`,
			channelsResult.unwrapErr(),
		);
		return err(NotificationDeliveryError.ChannelNotFound);
	}

	const channel = channelsResult
		.unwrap()
		.find((entry) => entry.id === String(channelId)) as
		| GuildChannel
		| undefined;
	if (isNullish(channel)) {
		container.logger.debug(
			`[twitch-notifications] Channel ${channelId} was not found in guild ${guildId}`,
		);
		return err(NotificationDeliveryError.ChannelNotFound);
	}

	if (!(await canSend(channel))) {
		container.logger.debug(
			`[twitch-notifications] Missing permissions to post in channel ${channelId} of guild ${guildId}`,
		);
		return err(NotificationDeliveryError.MissingPermissions);
	}

	container.logger.debug(
		`[twitch-notifications] Resolved channel ${channelId} (type ${channel.type}) of guild ${guildId}`,
	);
	return ok({ channel, t });
}

async function send(
	channelId: string,
	message: string | null,
	testNotice: boolean | undefined,
	t: TFunction,
	embeds?: APIEmbed[],
): Promise<Result<void, NotificationDeliveryError>> {
	// The mentions are extracted from the stored message alone; the test notice is a plain literal
	// and must not be able to widen `allowed_mentions`.
	const detailedMentions = extractDetailedMentions(message);
	const content = testNotice
		? [t(LanguageKeys.Events.Twitch.TestNotice), message]
				.filter(Boolean)
				.join("\n")
		: message;

	container.logger.debug(
		`[twitch-notifications] Sending to channel ${channelId}: contentLength=${content?.length ?? 0} embeds=${embeds?.length ?? 0} mentions=${JSON.stringify(detailedMentions)}`,
	);

	const result = await Result.fromAsync(() =>
		api().channels.createMessage(channelId, {
			content: content || undefined,
			embeds,
			allowed_mentions: {
				// `extractDetailedMentions` yields the raw string union, which is the same set of values
				// as the enum but not assignable to it.
				parse: cast<AllowedMentionsTypes[]>(detailedMentions.parse),
				users: [...detailedMentions.users],
				roles: [...detailedMentions.roles],
			},
		}),
	);

	if (result.isErr()) {
		container.logger.error(
			`[twitch-notifications] Discord rejected the notification for channel ${channelId}`,
			result.unwrapErr(),
		);
		return err(NotificationDeliveryError.SendFailed);
	}

	container.logger.debug(
		`[twitch-notifications] Notification delivered to channel ${channelId}`,
	);
	return ok();
}
