import type {
	NotifiedSource,
	SocialCard,
	SocialItem,
	SocialProvider,
} from "#social/provider";
import type { NotificationTarget } from "#utils/notificationDelivery";
import type { APIMessageTopLevelComponent } from "discord-api-types/v10";
import { canSendEmbeds } from "#utils/discordUtilities";
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
import { err, Result } from "@sapphire/result";
import { cutText, isNullishOrEmpty } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";
import { ButtonStyle } from "discord-api-types/v10";

const MaximumTitleLength = 200;
const MaximumBodyLength = 500;
const MaximumNameLength = 100;

/** Discord refuses a link button whose URL is longer than this. */
const MaximumLinkLength = 512;

/** The delivery side of the poller, kept narrow so a test can record what would be posted. */
export interface SocialDelivery {
	prepare(
		guildId: bigint,
		channelId: bigint,
	): Promise<Result<NotificationTarget, NotificationDeliveryError>>;
	send(
		target: NotificationTarget,
		delivery: {
			provider: SocialProvider;
			item: SocialItem;
			source: NotifiedSource;
			message: string | null;
			notice?: string;
		},
	): Promise<Result<void, NotificationDeliveryError>>;
}

export const socialDelivery: SocialDelivery = {
	prepare(guildId, channelId) {
		return resolveNotificationTarget(guildId, channelId, canSendEmbeds);
	},
	async send({ channel, t }, { provider, item, source, message, notice }) {
		// The builders throw on a URL they do not like. That has to stay a failed delivery of this one
		// item, so it runs out in the retry window instead of stopping the items behind it.
		const components = Result.from(() =>
			buildSocialComponents(
				// These two end up in a heading a provider writes, past `createSocialCard`'s escaping.
				provider.formatNotification(
					{
						...item,
						authorName: item.authorName && escapeName(item.authorName),
					},
					{ ...source, displayName: escapeName(source.displayName) },
					t,
				),
			),
		);
		if (components.isErr()) {
			container.logger.error(
				`[social-notifications] Could not build the card of ${item.url}`,
				components.unwrapErr(),
			);
			return err(NotificationDeliveryError.SendFailed);
		}

		return sendNotificationMessage(
			channel.id,
			message,
			notice,
			components.unwrap(),
		);
	},
};

export function isNsfwChannel({ channel }: NotificationTarget) {
	return "nsfw" in channel && Boolean(channel.nsfw);
}

/**
 * Text coming from a source ends up inside this bot's message. `allowed_mentions` already keeps it
 * from pinging anyone; this keeps it from restyling the card or retargeting the link around it.
 */
export function escapeInlineText(text: string) {
	return escapeMarkdown(text, {
		bulletedList: true,
		heading: true,
		numberedList: true,
	}).replace(/[[\]]/g, "\\$&");
}

function escapeName(name: string) {
	return escapeInlineText(cutText(name, MaximumNameLength));
}

/** Whether a URL taken from a source can be linked to, or `null` when it cannot. */
export function parseItemUrl(url: string | null | undefined): string | null {
	if (!URL.canParse(url ?? "")) return null;

	const parsed = new URL(url!);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	// A closing parenthesis would end the markdown link early.
	const href = parsed.href.replaceAll(")", "%29");
	return href.length <= MaximumLinkLength ? href : null;
}

/** Discord only fetches pictures from `https`, and a broken one fails the whole message. */
export function parseImageUrl(url: string | null | undefined): string | null {
	const parsed = parseItemUrl(url);
	return parsed?.startsWith("https:") ? parsed : null;
}

export function createSocialCard(
	item: SocialItem,
	options: Pick<SocialCard, "accentColor" | "heading" | "footer" | "linkLabel">,
): SocialCard {
	return {
		...options,
		title: isNullishOrEmpty(item.title)
			? null
			: // A line break would end the heading the title is rendered in, with its link half open.
				escapeInlineText(
					cutText(item.title.replace(/\s+/g, " "), MaximumTitleLength),
				),
		url: parseItemUrl(item.url) ?? item.url,
		body: isNullishOrEmpty(item.text)
			? null
			: escapeInlineText(cutText(item.text, MaximumBodyLength)),
		thumbnailUrl: parseImageUrl(item.authorAvatarUrl),
		imageUrl: parseImageUrl(item.imageUrl),
		// A source can send anything as a date, and an invalid one would print as `<t:NaN:f>`.
		publishedAt: Number.isNaN(item.publishedAt?.getTime())
			? null
			: item.publishedAt,
	};
}

export function buildSocialComponents(
	card: SocialCard,
): APIMessageTopLevelComponent[] {
	const lines = [`**${card.heading}**`];
	if (card.title) lines.push(`### [${card.title}](${card.url})`);
	if (card.body) lines.push(card.body);
	const details = lines.map((line) =>
		new TextDisplayBuilder().setContent(line),
	);

	const container = new ContainerBuilder().setAccentColor(card.accentColor);
	if (card.thumbnailUrl) {
		container.addSectionComponents(
			new SectionBuilder()
				.addTextDisplayComponents(...details)
				.setThumbnailAccessory(
					new ThumbnailBuilder().setURL(card.thumbnailUrl),
				),
		);
	} else {
		container.addTextDisplayComponents(...details);
	}

	if (card.imageUrl) {
		const imageUrl = card.imageUrl;
		container.addMediaGalleryComponents(
			new MediaGalleryBuilder().addItems((item) => item.setURL(imageUrl)),
		);
	}

	const published = card.publishedAt
		? ` • ${time(card.publishedAt, TimestampStyles.ShortDateTime)}`
		: "";
	container.addTextDisplayComponents(
		new TextDisplayBuilder().setContent(`-# ${card.footer}${published}`),
	);

	const link = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel(card.linkLabel)
			.setURL(card.url),
	);

	return [container.toJSON(), link.toJSON()];
}
