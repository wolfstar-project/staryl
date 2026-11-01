import type { AnyNamespace, TFunction } from "@wolfstar/plugin-i18next";
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
import { extractDetailedMentions } from "#utils/util";
import { TextDisplayBuilder } from "@discordjs/builders";
import { err, ok, Result } from "@sapphire/result";
import { cast, isNullish } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";
import { MessageFlags } from "discord-api-types/v10";

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

export type GuildChannel = Exclude<
	APIChannel,
	APIDMChannel | APIGroupDMChannel
>;

export interface NotificationTarget {
	channel: GuildChannel;
	t: TFunction<AnyNamespace>;
}

/**
 * Resolves the guild's language and the channel to post in, refusing the delivery when the bot
 * cannot post there.
 *
 * `canSend` is awaited: both listeners used to negate the returned promise, which is always truthy,
 * so the permission gate never rejected anything and the send failed against Discord instead.
 */
export async function resolveNotificationTarget(
	guildId: bigint,
	channelId: bigint,
	canSend: (channel: GuildChannel, roles: APIRole[]) => Promise<boolean>,
): Promise<Result<NotificationTarget, NotificationDeliveryError>> {
	const guildResult = await Result.fromAsync(() =>
		api().guilds.get(String(guildId)),
	);
	if (guildResult.isErr() || isNullish(guildResult.unwrap())) {
		container.logger.debug(
			`[notifications] Guild ${guildId} is unavailable`,
			guildResult.isErr() ? guildResult.unwrapErr() : undefined,
		);
		return err(NotificationDeliveryError.GuildUnavailable);
	}

	// `container.i18n.getT` throws when Discord reports a locale the bot has not loaded (e.g. `de`
	// while only `en-US` is bundled). An unsupported guild locale must degrade to the default
	// language, not escape this function and abort the delivery outside the `Result` error path.
	const preferredLocale = (guildResult.unwrap().preferred_locale ??
		"en-US") as Locale;
	const resolvedLocale = container.i18n.languages.has(preferredLocale)
		? preferredLocale
		: "en-US";
	container.logger.debug(
		`[notifications] Guild ${guildId} preferred locale ${preferredLocale}, resolved to ${resolvedLocale}`,
	);
	const t = cast<TFunction<AnyNamespace>>(container.i18n.getT(resolvedLocale));

	const channelsResult = await Result.fromAsync(() =>
		api().guilds.getChannels(String(guildId)),
	);
	if (channelsResult.isErr()) {
		container.logger.debug(
			`[notifications] Could not list the channels of guild ${guildId}`,
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
			`[notifications] Channel ${channelId} was not found in guild ${guildId}`,
		);
		return err(NotificationDeliveryError.ChannelNotFound);
	}

	if (!(await canSend(channel, guildResult.unwrap().roles))) {
		container.logger.debug(
			`[notifications] Missing permissions to post in channel ${channelId} of guild ${guildId}`,
		);
		return err(NotificationDeliveryError.MissingPermissions);
	}

	container.logger.debug(
		`[notifications] Resolved channel ${channelId} (type ${channel.type}) of guild ${guildId}`,
	);
	return ok({ channel, t });
}

/**
 * Posts a notification. `notice` is the already localized line that precedes a manually triggered
 * preview, so a caller decides what a preview says without this module knowing about it.
 */
export async function sendNotificationMessage(
	channelId: string,
	message: string | null,
	notice: string | undefined,
	components?: APIMessageTopLevelComponent[],
): Promise<Result<void, NotificationDeliveryError>> {
	// The mentions are extracted from the stored message alone; the notice is a plain literal and
	// must not be able to widen `allowed_mentions`.
	const detailedMentions = extractDetailedMentions(message);
	const content = notice
		? [notice, message].filter(Boolean).join("\n")
		: message;

	container.logger.debug(
		`[notifications] Sending to channel ${channelId}: contentLength=${content?.length ?? 0} components=${components?.length ?? 0} mentions=${JSON.stringify(
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
			`[notifications] Discord rejected the notification for channel ${channelId}`,
			result.unwrapErr(),
		);
		return err(NotificationDeliveryError.SendFailed);
	}

	container.logger.debug(
		`[notifications] Notification delivered to channel ${channelId}`,
	);
	return ok();
}
