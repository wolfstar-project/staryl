import type { AnyNamespace, TFunction } from "@wolfstar/plugin-i18next";
import type {
	TwitchEventSubOnlineEvent,
	TwitchHelixStreamsResult,
	TwitchOnlineEmbedData,
} from "@wolfstar/twitch-helpers";
import type {
	AllowedMentionsTypes,
	APIChannel,
	APIDMChannel,
	APIGroupDMChannel,
	APIMessageTopLevelComponent,
	APIRole,
	Locale,
} from "discord-api-types/v10";
import { api } from "#utils/discordApi";
import { canSendEmbeds, canSendMessages } from "#utils/discordUtilities";
import { extractDetailedMentions } from "#utils/util";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ContainerBuilder,
	escapeMarkdown,
	MediaGalleryBuilder,
	SectionBuilder,
	TextDisplayBuilder,
	ThumbnailBuilder,
	time,
	TimestampStyles,
} from "@discordjs/builders";
import { err, ok, Result } from "@sapphire/result";
import { cast, isNullish } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";
import { TwitchBrandingColor } from "@wolfstar/twitch-helpers";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";

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
	/** The streamer's profile picture, shown when the stream has no game art. Omitted when it is unknown. */
	avatarUrl?: string | null;
	/**
	 * Prepends the localized test notice to the content so the members of the
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

/** The data an online notification is rendered from. */
export interface OnlineNotificationData extends TwitchOnlineEmbedData {
	/** The lowercase login name, which is what Twitch's URLs are keyed on. */
	userLogin: string;
	avatarUrl?: string;
}

type GuildChannel = Exclude<APIChannel, APIDMChannel | APIGroupDMChannel>;

interface NotificationTarget {
	channel: GuildChannel;
	t: TFunction<AnyNamespace>;
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
	const data = buildOnlineEmbedData(
		options.event,
		options.streamData,
		options.avatarUrl,
	);
	if (data.embedImageUrl && !(await isLivePreviewReady(data.embedImageUrl))) {
		container.logger.debug(
			`[twitch-notifications] No preview frame yet for ${data.userLogin}, leaving the gallery out`,
		);
		data.embedImageUrl = undefined;
	}
	container.logger.debug(
		`[twitch-notifications] Online embed data for channel ${channel.id}: ${JSON.stringify(data)}`,
	);

	// A `test` on a streamer that is not live has no stream to describe. Only the test path
	// substitutes a placeholder title: a real notification that raced ahead of Twitch's stream data
	// falls back to the streamer's name in the heading instead.
	if (options.testNotice && isNullish(options.streamData)) {
		data.title = t("events/twitch:testPlaceholderTitle");
		container.logger.debug(
			`[twitch-notifications] No stream data for channel ${channel.id}, substituting the placeholder title`,
		);
	}

	// The custom message is optional for online subscriptions, the container alone is already the
	// notification.
	return send(channel.id, options.message, options.testNotice, t, [
		...buildOnlineComponents(data, t),
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
	avatarUrl?: string | null,
): OnlineNotificationData {
	const userLogin = notification.broadcaster_user_login.toLowerCase();

	return {
		avatarUrl: avatarUrl ?? undefined,
		embedThumbnailUrl: streamData?.game_box_art_url?.replace(
			kTwitchImageReplacerRegex,
			"128",
		),
		gameName: streamData?.game_name,
		language: streamData?.language,
		startedAt: new Date(notification.started_at),
		title: escapeText(streamData?.title),
		userLogin,
		userName: notification.broadcaster_user_name,
		viewerCount: streamData?.viewer_count,
		// The `thumbnail_url` of the Helix stream is a cached snapshot that is often minutes old and
		// downscaled; the live preview endpoint always serves the current frame at full size. A
		// preview only exists while the streamer is live, so it is skipped without stream data.
		embedImageUrl: isNullish(streamData)
			? undefined
			: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${userLogin}-0x0.jpg?t=${Date.now()}`,
	};
}

export function buildOnlineComponents(
	data: OnlineNotificationData,
	t: TFunction<AnyNamespace>,
): APIMessageTopLevelComponent[] {
	const url = `https://twitch.tv/${data.userLogin}`;

	// An empty title (Twitch has not published the stream yet — a routine race at go-live) would
	// render as a bare link, so the streamer's name stands in for it.
	const lines = [
		`**${t("events/twitch:embedHeader", { userName: escapeText(data.userName) })}**`,
		`### [${data.title || escapeText(data.userName)}](${url})`,
	];
	if (data.gameName) {
		lines.push(
			`**${t("events/twitch:embedGame")}**\n${escapeText(data.gameName)}`,
		);
	}
	const details = lines.map((line) =>
		new TextDisplayBuilder().setContent(line),
	);

	const card = new ContainerBuilder().setAccentColor(TwitchBrandingColor);

	// One picture beside the text, as the embed this replaced had: the game's box art, or the
	// streamer's avatar when the stream has no game. A section needs a thumbnail accessory, so the
	// text falls back to plain displays when there is neither.
	const thumbnailUrl = data.embedThumbnailUrl || data.avatarUrl;
	if (thumbnailUrl) {
		card.addSectionComponents(
			new SectionBuilder()
				.addTextDisplayComponents(...details)
				.setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl)),
		);
	} else {
		card.addTextDisplayComponents(...details);
	}

	const previewUrl = data.embedImageUrl;
	if (previewUrl) {
		card.addMediaGalleryComponents(
			new MediaGalleryBuilder().addItems((item) => item.setURL(previewUrl)),
		);
	}

	card.addTextDisplayComponents(
		new TextDisplayBuilder().setContent(
			`-# ${t("events/twitch:offlinePostfix")} • ${time(data.startedAt, TimestampStyles.ShortDateTime)}`,
		),
	);

	const watch = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel(t("events/twitch:watchStream"))
			.setURL(url),
	);

	return [card.toJSON(), watch.toJSON()];
}

/**
 * Whether Twitch has a frame of the stream at `url`. Right after going live it has none yet and
 * redirects to its grey "no preview" image; Discord keeps whatever it first fetched in the
 * message, so that image would stay for good. A failed check counts as no frame: the notification
 * goes out without the picture rather than late.
 */
export async function isLivePreviewReady(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.timeout(3_000),
		});
		return response.status === 200;
	} catch {
		return false;
	}
}

export function buildOfflineMessage(
	message: string,
	date: Date,
	t: TFunction<AnyNamespace>,
): string {
	return `${message} | ${time(date, TimestampStyles.ShortDateTime)} | ${t("events/twitch:offlinePostfix")}`;
}

export function escapeText(text?: string) {
	if (isNullish(text)) {
		return "";
	}

	// `escapeMarkdown` leaves `[` and `]` alone, and `maskedLink` only matches a whole `[..](..)`
	// pair. The title is streamer-controlled and ends up inside the link text of the heading, so a
	// stray `](` would otherwise retarget the link.
	return escapeMarkdown(
		text.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"'),
	).replace(/[[\]]/g, "\\$&");
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
	canSend: (channel: GuildChannel, roles: APIRole[]) => Promise<boolean>,
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

	// `container.i18n.getT` throws when Discord reports a locale the bot has not loaded (e.g. `de`
	// while only `en-US` is bundled). An unsupported guild locale must degrade to the default
	// language, not escape `resolveTarget` and abort the delivery outside the `Result` error path.
	const preferredLocale = (guildResult.unwrap().preferred_locale ??
		"en-US") as Locale;
	const resolvedLocale = container.i18n.languages.has(preferredLocale)
		? preferredLocale
		: "en-US";
	container.logger.debug(
		`[twitch-notifications] Guild ${guildId} preferred locale ${preferredLocale}, resolved to ${resolvedLocale}`,
	);
	const t = cast<TFunction<AnyNamespace>>(container.i18n.getT(resolvedLocale));

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

	if (!(await canSend(channel, guildResult.unwrap().roles))) {
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
	t: TFunction<AnyNamespace>,
	components?: APIMessageTopLevelComponent[],
): Promise<Result<void, NotificationDeliveryError>> {
	// The mentions are extracted from the stored message alone; the test notice is a plain literal
	// and must not be able to widen `allowed_mentions`.
	const detailedMentions = extractDetailedMentions(message);
	const content = testNotice
		? [t("events/twitch:testNotice"), message].filter(Boolean).join("\n")
		: message;

	container.logger.debug(
		`[twitch-notifications] Sending to channel ${channelId}: contentLength=${content?.length ?? 0} components=${components?.length ?? 0} mentions=${JSON.stringify(
			{
				parse: detailedMentions.parse,
				users: [...detailedMentions.users],
				roles: [...detailedMentions.roles],
				channels: [...detailedMentions.channels],
			},
		)}`,
	);

	// Components V2 messages cannot carry `content`, so the text moves into a leading text display.
	const result = await Result.fromAsync(() =>
		api().channels.createMessage(channelId, {
			...(components
				? {
						components: [
							...(content
								? [new TextDisplayBuilder().setContent(content).toJSON()]
								: []),
							...components,
						],
						flags: MessageFlags.IsComponentsV2,
					}
				: { content: content || undefined }),
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
