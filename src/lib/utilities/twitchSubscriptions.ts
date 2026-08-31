import type {
	GuildSubscription,
	Prisma,
	TwitchSubscription,
} from "#lib/setup/prisma";
import type { Command } from "@wolfstar/http-framework";
import type {
	TwitchEventSubResult,
	TwitchEventSubTypes,
	TwitchHelixResponse,
	TwitchHelixUsersSearchResult,
} from "@wolfstar/twitch-helpers";
import type { APIChannel } from "discord-api-types/v10";
import { TwitchSubscriptionType } from "#generated/prisma";
import { LanguageKeys } from "#i18n";
import { NotificationDeliveryError } from "#utils/twitchNotifications";
import {
	SlashCommandChannelOption,
	SlashCommandStringOption,
} from "@discordjs/builders";
import { channelMention } from "@discordjs/formatters";
import { err, ok, Result } from "@sapphire/result";
import { cast } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";
import {
	applyLocalizedBuilder,
	createSelectMenuChoiceName,
	getSupportedLanguageT as resolveKey,
} from "@wolfstar/plugin-i18next";
import {
	fetchUsers,
	getRequest,
	removeEventSubscription,
} from "@wolfstar/twitch-helpers";
import { ChannelType } from "discord-api-types/v10";

const Root = LanguageKeys.Commands.Twitch;
type SubscriptionFailureKey = typeof Root.RemoveFailed | typeof Root.TestFailed;

/**
 * The chat-input name of the parent command owning every subscription subcommand.
 *
 * Shared by the parent's builder and each child's decorator so the two cannot drift apart; a
 * mismatch would silently leave the child unrouted.
 */
export const SubscriptionsCommandName = "subscriptions";

/**
 * The name of the subcommand group holding the Twitch subcommands.
 *
 * Must match the group declared on the parent command, see {@link SubscriptionsCommandName}.
 */
export const TwitchGroupName = "twitch";

/**
 * Matches the `@db.VarChar(200)` column backing {@link GuildSubscription.message}; without it Discord accepts
 * messages the database rejects, and the insert fails after the Twitch subscription has already been created.
 */
export const MaximumMessageLength = 200;

/**
 * The `users` Twitch Helix endpoint accepts at most 100 ids per request.
 */
export const MaximumUsersPerRequest = 100;

/**
 * The message the `test` subcommand answers with for each delivery failure. Every entry names the
 * concrete thing to fix, since diagnosing a silent notification is the whole point of the command.
 */
export const DeliveryErrorKeys = {
	[NotificationDeliveryError.GuildUnavailable]: Root.TestFailedGuild,
	[NotificationDeliveryError.ChannelNotFound]: Root.TestFailedChannel,
	[NotificationDeliveryError.MissingPermissions]: Root.TestFailedPermissions,
	[NotificationDeliveryError.SendFailed]: Root.TestFailedSend,
} as const;

export type GuildSubscriptionWithTwitch = GuildSubscription & {
	twitchSubscription: TwitchSubscription;
};

export interface TwitchSubscriptionOptions {
	streamer: string;
	channel: APIChannel;
	type: TwitchSubscriptionType;
	message: string | null;
}

export interface TwitchStreamerFilterOptions {
	streamer?: string;
}

export interface TwitchChannelSearchResult {
	broadcaster_login: string;
	display_name: string;
	id: string;
	is_live: boolean;
}

export function createTypeChoiceOption() {
	return applyLocalizedBuilder(
		new SlashCommandStringOption(),
		Root.OptionsTypeName,
		Root.OptionsTypeDescription,
	).addChoices(
		createSelectMenuChoiceName(Root.OptionsTypeChoiceOnline, {
			value: "StreamOnline",
		}),
		createSelectMenuChoiceName(Root.OptionsTypeChoiceOffline, {
			value: "StreamOffline",
		}),
	);
}

export function createChannelOption() {
	return applyLocalizedBuilder(
		new SlashCommandChannelOption(),
		Root.OptionsChannelName,
		Root.OptionsChannelDescription,
	).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
}

export function createStreamerOption(required: boolean) {
	return applyLocalizedBuilder(
		new SlashCommandStringOption(),
		Root.OptionsStreamerName,
		Root.OptionsStreamerDescription,
	)
		.setRequired(required)
		.setAutocomplete(true);
}

/**
 * The return type is spelled out because the callers live in other modules: the inferred Prisma
 * payload does not survive the declaration boundary and would degrade to `any` there.
 */
export function getGuildSubscriptions(
	guildId: bigint,
): Promise<Result<GuildSubscriptionWithTwitch[], unknown>> {
	return Result.fromAsync(() =>
		container.prisma.guildSubscription.findMany({
			where: { guildId },
			include: { twitchSubscription: true },
		}),
	);
}

export function getSubscriptionStatus(
	subscription: TwitchSubscriptionType,
	statuses: { live: string; offline: string },
) {
	return subscription === TwitchSubscriptionType.StreamOnline
		? statuses.live
		: statuses.offline;
}

export function createGuildSubscription(
	guildId: bigint,
	channelId: bigint,
	message: string | null,
	twitchSubscription: Prisma.TwitchSubscriptionCreateNestedOneWithoutGuildSubscriptionInput,
) {
	return container.prisma.guildSubscription.create({
		data: {
			channelId,
			message: message ?? undefined,
			guild: {
				connectOrCreate: {
					where: { id: guildId },
					create: { id: guildId },
				},
			},
			twitchSubscription,
		},
		select: null,
	});
}

/**
 * Checks whether Twitch still lists an EventSub subscription.
 *
 * The listing is filtered by broadcaster and event type, which narrows it to the handful of
 * subscriptions that can exist for that pair, and every pagination cursor Twitch returns is
 * still followed so the subscription is only reported absent once the listing is exhausted.
 *
 * A failed lookup still answers `false`: callers must read it as "not confirmed" and never rely on
 * the subscription.
 */
export async function isEventSubSubscriptionListed(
	streamerId: string,
	subscriptionType: TwitchEventSubTypes,
	subscriptionId: string,
) {
	const query = `user_id=${encodeURIComponent(streamerId)}&type=${encodeURIComponent(subscriptionType)}`;
	let cursor: string | undefined;
	do {
		const path = `eventsub/subscriptions?${query}${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
		// oxlint-disable-next-line no-await-in-loop -- each cursor comes from the previous response
		const result = await Result.fromAsync(() =>
			getRequest<
				TwitchHelixResponse<TwitchEventSubResult> & {
					pagination?: { cursor?: string };
				}
			>(path),
		);
		if (result.isErr()) {
			container.logger.error(
				`[twitch-subscriptions] Failed to list the ${subscriptionType} EventSub subscriptions of ${streamerId} while confirming "${subscriptionId}"`,
				result.unwrapErr(),
			);
			return false;
		}

		const { data, pagination } = result.unwrap();
		if (data.some((entry) => entry.id === subscriptionId)) return true;
		cursor = pagination?.cursor;
	} while (cursor);

	return false;
}

/**
 * Resolves the guild subscription matching the streamer, channel and status trio, or the message
 * to answer with when there is none.
 *
 * Shared by `remove` and `test` so both report the same reason for the same mismatch; only the
 * message used when the lookup itself fails differs, hence {@link failedKey}.
 */
export async function resolveSubscription(
	interaction: Command.ChatInputInteraction,
	streamer: TwitchHelixUsersSearchResult,
	channel: APIChannel,
	subscriptionType: TwitchSubscriptionType,
	failedKey: SubscriptionFailureKey,
): Promise<Result<GuildSubscriptionWithTwitch, string>> {
	const guildSubscriptionsResult = await getGuildSubscriptions(
		BigInt(interaction.guildId!),
	);
	if (guildSubscriptionsResult.isErr()) {
		container.logger.error(
			"[twitch-subscriptions] Failed to read the guild subscriptions",
			guildSubscriptionsResult.unwrapErr(),
		);
		return err(cast<string>(await resolveKey(interaction, failedKey)));
	}

	const guildSubscriptions = guildSubscriptionsResult.unwrap();
	const streamers = guildSubscriptions.filter(
		({ twitchSubscription }) => twitchSubscription.streamerId === streamer.id,
	);
	container.logger.debug(
		`[twitch-subscriptions] Guild ${interaction.guildId} has ${guildSubscriptions.length} subscription(s), ${streamers.length} of them for streamer ${streamer.id}`,
	);

	if (!streamers.length) {
		container.logger.debug(
			`[twitch-subscriptions] Guild ${interaction.guildId} is not subscribed to streamer ${streamer.id}`,
		);
		return err(
			cast<string>(
				await resolveKey(interaction, Root.RemoveStreamerNotSubscribed, {
					streamer: streamer.display_name,
				}),
			),
		);
	}

	const statuses = streamers.filter(
		({ twitchSubscription }) =>
			twitchSubscription.subscriptionType === subscriptionType,
	);

	if (!statuses.length) {
		container.logger.debug(
			`[twitch-subscriptions] Streamer ${streamer.id} has no ${subscriptionType} subscription in guild ${interaction.guildId}`,
		);
		const showStatuses = await resolveKey(interaction, Root.ShowStatus);
		return err(
			cast<string>(
				await resolveKey(interaction, Root.RemoveStreamerStatusNotMatch, {
					streamer: streamer.display_name,
					status: getSubscriptionStatus(subscriptionType, showStatuses),
				}),
			),
		);
	}

	const match = statuses.find(
		(guildSubscription) => guildSubscription.channelId === BigInt(channel.id),
	);

	if (!match) {
		container.logger.debug(
			`[twitch-subscriptions] The ${subscriptionType} subscription of streamer ${streamer.id} does not point at channel ${channel.id}`,
		);
		return err(
			cast<string>(
				await resolveKey(interaction, Root.RemoveNotToProvidedChannel, {
					channel: channelMention(channel.id),
				}),
			),
		);
	}

	return ok(match);
}

export async function getStreamer(streamerName: string) {
	// `Result.fromAsync` flattens the returned `FetchResult` and additionally catches the errors
	// `fetchUsers` throws when the Twitch client credentials are missing.
	const result = await Result.fromAsync(() =>
		fetchUsers({ logins: [streamerName] }),
	);
	if (result.isErr()) {
		container.logger.error(
			`[twitch-subscriptions] Failed to look up the streamer "${streamerName}"`,
			result.unwrapErr(),
		);
		return null;
	}

	const { data } = result.unwrap();
	container.logger.debug(
		`[twitch-subscriptions] Look-up of the streamer "${streamerName}" returned ${data.length} result(s)`,
	);
	return data.length > 0 ? data[0] : null;
}

export async function fetchStreamerNames(streamerIds: readonly string[]) {
	const names = new Map<string, string>();
	const uniqueIds = [...new Set(streamerIds)];

	for (
		let index = 0;
		index < uniqueIds.length;
		index += MaximumUsersPerRequest
	) {
		const chunk = uniqueIds.slice(index, index + MaximumUsersPerRequest);
		// oxlint-disable-next-line no-await-in-loop -- sequential to stay within Twitch's rate limits
		const result = await Result.fromAsync(() => fetchUsers({ ids: chunk }));
		if (result.isErr()) {
			container.logger.error(
				"[twitch-subscriptions] Failed to resolve the streamer names",
				result.unwrapErr(),
			);
			continue;
		}

		for (const profile of result.unwrap().data) {
			names.set(profile.id, profile.display_name);
		}
	}

	return names;
}

export async function deleteSubscription(subscription: GuildSubscription) {
	await container.prisma.guildSubscription.delete({
		where: {
			guildId_channelId_subscriptionId: {
				guildId: subscription.guildId,
				channelId: subscription.channelId,
				subscriptionId: subscription.subscriptionId,
			},
		},
		select: null,
	});
}

export async function removeSubscription(
	subscriptionId: bigint,
): Promise<void> {
	const twitchSubscription =
		await container.prisma.twitchSubscription.findFirst({
			where: { id: subscriptionId },
			include: { guildSubscription: true },
		});
	if (!twitchSubscription) return;
	if (twitchSubscription.guildSubscription.length === 0) {
		await removeEventSubscription(twitchSubscription.subscriptionId);
		await container.prisma.twitchSubscription.delete({
			where: { id: subscriptionId },
			select: null,
		});
	}
}
