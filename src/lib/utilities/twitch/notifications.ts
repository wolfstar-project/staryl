import type { Result } from "@sapphire/result";
import type { AnyNamespace, TFunction } from "@wolfstar/plugin-i18next";
import type {
	TwitchEventSubOnlineEvent,
	TwitchHelixStreamsResult,
	TwitchOnlineEmbedData,
} from "@wolfstar/twitch-helpers";
import type { APIMessageTopLevelComponent } from "discord-api-types/v10";
import { canSendEmbeds, canSendMessages } from "#utils/discordUtilities";
import {
	NotificationDeliveryError,
	resolveNotificationTarget,
	sendNotificationMessage,
} from "#utils/notificationDelivery";
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
import { err } from "@sapphire/result";
import { isNullish } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";
import { TwitchBrandingColor } from "@wolfstar/twitch-helpers";
import { ButtonStyle } from "discord-api-types/v10";

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

const kTwitchImageReplacerRegex = /(\{width\}|\{height\})/gi;

export async function sendOnlineNotification(
	options: OnlineNotificationOptions,
): Promise<Result<void, NotificationDeliveryError>> {
	container.logger.debug(
		`[twitch-notifications] sendOnlineNotification guild=${options.guildId} channel=${options.channelId} streamer=${options.event.broadcaster_user_login} startedAt=${options.event.started_at} hasStreamData=${!isNullish(options.streamData)} hasMessage=${!isNullish(options.message)} testNotice=${options.testNotice ?? false}`,
	);

	const targetResult = await resolveNotificationTarget(
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
	return sendNotificationMessage(
		channel.id,
		options.message,
		resolveTestNotice(options, t),
		[...buildOnlineComponents(data, t)],
	);
}

export async function sendOfflineNotification(
	options: OfflineNotificationOptions,
): Promise<Result<void, NotificationDeliveryError>> {
	container.logger.debug(
		`[twitch-notifications] sendOfflineNotification guild=${options.guildId} channel=${options.channelId} date=${options.date.toISOString()} testNotice=${options.testNotice ?? false}`,
	);

	const targetResult = await resolveNotificationTarget(
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

	return sendNotificationMessage(
		channel.id,
		content,
		resolveTestNotice(options, t),
	);
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

function resolveTestNotice(
	options: Pick<OnlineNotificationOptions, "testNotice">,
	t: TFunction<AnyNamespace>,
) {
	return options.testNotice ? t("events/twitch:testNotice") : undefined;
}
