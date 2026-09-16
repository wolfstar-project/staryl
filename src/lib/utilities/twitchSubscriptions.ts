import type {
	GuildSubscription,
	Prisma,
	TwitchSubscription,
} from "#lib/setup/prisma";
import type { Command } from "@wolfstar/http-framework";
import type {
	TwitchEventSubResult,
	TwitchHelixResponse,
	TwitchHelixUsersSearchResult,
} from "@wolfstar/twitch-helpers";
import type { APIChannel } from "discord-api-types/v10";
import { TwitchSubscriptionType } from "#generated/prisma";
import {
	NotificationDeliveryError,
	sendOfflineNotification,
	sendOnlineNotification,
} from "#utils/twitchNotifications";
import {
	SlashCommandChannelOption,
	SlashCommandStringOption,
} from "@discordjs/builders";
import { channelMention } from "@discordjs/formatters";
import { err, ok, Result } from "@sapphire/result";
import { cast, isNullish, isNullishOrEmpty } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";
import {
	applyLocalizedBuilder,
	createSelectMenuChoiceName,
	getSupportedLanguageT as resolveKey,
} from "@wolfstar/plugin-i18next";
import {
	addEventSubscription,
	areTwitchEventSubCredentialsSet,
	fetchStream,
	fetchUsers,
	getRequest,
	removeEventSubscription,
	TwitchEventSubTypes,
} from "@wolfstar/twitch-helpers";
import { ChannelType } from "discord-api-types/v10";

type SubscriptionFailureKey =
	| "commands/twitch:removeFailed"
	| "commands/twitch:testFailed";

/**
 * The keys `addSubscription` fails with; every entry names the exact reason so the caller (the
 * slash command today, a component/modal-driven UI later) can resolve its own localized message
 * without needing to know how the failure was produced.
 */
export type AddSubscriptionErrorKey =
	| "commands/twitch:addMessageForOfflineRequired"
	| "commands/twitch:streamerNotFound"
	| "commands/twitch:addFailedDatabase"
	| "commands/twitch:addDuplicated"
	| "commands/twitch:addFailedTwitch";

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
	[NotificationDeliveryError.GuildUnavailable]:
		"commands/twitch:testFailedGuild",
	[NotificationDeliveryError.ChannelNotFound]:
		"commands/twitch:testFailedChannel",
	[NotificationDeliveryError.MissingPermissions]:
		"commands/twitch:testFailedPermissions",
	[NotificationDeliveryError.SendFailed]: "commands/twitch:testFailedSend",
	/** {@link testSubscriptionDelivery} answers this when an offline subscription has no message. */
	missingMessage: "commands/twitch:testMissingMessage",
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
		"commands/twitch:optionsTypeName",
		"commands/twitch:optionsTypeDescription",
	).addChoices(
		createSelectMenuChoiceName("commands/twitch:optionsTypeChoiceOnline", {
			value: "StreamOnline",
		}),
		createSelectMenuChoiceName("commands/twitch:optionsTypeChoiceOffline", {
			value: "StreamOffline",
		}),
	);
}

export function createChannelOption() {
	return applyLocalizedBuilder(
		new SlashCommandChannelOption(),
		"commands/twitch:optionsChannelName",
		"commands/twitch:optionsChannelDescription",
	).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
}

export function createStreamerOption(required: boolean) {
	return applyLocalizedBuilder(
		new SlashCommandStringOption(),
		"commands/twitch:optionsStreamerName",
		"commands/twitch:optionsStreamerDescription",
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
				await resolveKey(
					interaction,
					"commands/twitch:removeStreamerNotSubscribed",
					{
						streamer: streamer.display_name,
					},
				),
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
		const showStatuses = await resolveKey(
			interaction,
			"commands/twitch:showStatus",
		);
		return err(
			cast<string>(
				await resolveKey(
					interaction,
					"commands/twitch:removeStreamerStatusNotMatch",
					{
						streamer: streamer.display_name,
						status: getSubscriptionStatus(subscriptionType, showStatuses),
					},
				),
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
				await resolveKey(
					interaction,
					"commands/twitch:removeNotToProvidedChannel",
					{
						channel: channelMention(channel.id),
					},
				),
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

/**
 * Mirrors {@link getStreamer}, but resolves by Twitch id instead of login name. A component or
 * modal driven UI hands back the id it was built with rather than re-typing the login.
 */
export async function getStreamerById(streamerId: string) {
	// `Result.fromAsync` flattens the returned `FetchResult` and additionally catches the errors
	// `fetchUsers` throws when the Twitch client credentials are missing.
	const result = await Result.fromAsync(() =>
		fetchUsers({ ids: [streamerId] }),
	);
	if (result.isErr()) {
		container.logger.error(
			`[twitch-subscriptions] Failed to look up the streamer by id "${streamerId}"`,
			result.unwrapErr(),
		);
		return null;
	}

	const { data } = result.unwrap();
	container.logger.debug(
		`[twitch-subscriptions] Look-up of the streamer id "${streamerId}" returned ${data.length} result(s)`,
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

/**
 * Subscribes a guild channel to a streamer's online/offline events, creating the shared
 * `TwitchSubscription` row (and its EventSub subscription) the first time any guild asks for that
 * streamer/type pair, or connecting to the existing one otherwise.
 *
 * Shared by the `add` slash command and, later, a component/modal driven UI: both need the exact
 * same validation, duplicate check and rollback-and-orphan-prevention behaviour, so it lives here
 * instead of inside a command's `chatInputRun`.
 */
export async function addSubscription(
	guildId: bigint,
	channelId: bigint,
	streamerLogin: string,
	type: TwitchSubscriptionType,
	message: string | null,
): Promise<
	Result<{ streamer: TwitchHelixUsersSearchResult }, AddSubscriptionErrorKey>
> {
	if (
		type === TwitchSubscriptionType.StreamOffline &&
		isNullishOrEmpty(message)
	) {
		return err("commands/twitch:addMessageForOfflineRequired");
	}

	const streamer = await getStreamer(streamerLogin);
	if (isNullish(streamer)) {
		return err("commands/twitch:streamerNotFound");
	}

	const existingResult = await Result.fromAsync(() =>
		Promise.all([
			container.prisma.twitchSubscription.findFirst({
				where: { streamerId: streamer.id, subscriptionType: type },
			}),
			container.prisma.guildSubscription.findMany({
				where: { guildId, channelId },
				include: { twitchSubscription: true },
			}),
		]),
	);
	if (existingResult.isErr()) {
		container.logger.error(
			"[twitch-subscriptions] Failed to read the existing subscriptions",
			existingResult.unwrapErr(),
		);
		return err("commands/twitch:addFailedDatabase");
	}

	const [streamerForType, guildSubscriptionsForChannel] =
		existingResult.unwrap();

	const alreadyHasEntry = guildSubscriptionsForChannel.some(
		(guildSubscription) =>
			guildSubscription.twitchSubscription.streamerId === streamer.id &&
			guildSubscription.twitchSubscription.subscriptionType === type,
	);

	if (alreadyHasEntry) {
		return err("commands/twitch:addDuplicated");
	}

	if (streamerForType) {
		const createdResult = await Result.fromAsync(() =>
			createGuildSubscription(guildId, channelId, message, {
				connect: { id: streamerForType.id },
			}),
		);
		if (createdResult.isErr()) {
			container.logger.error(
				"[twitch-subscriptions] Failed to store the guild subscription",
				createdResult.unwrapErr(),
			);
			return err("commands/twitch:addFailedDatabase");
		}
	} else {
		// Only this branch talks to Twitch; the branch above merely connects an already existing
		// subscription, so it must stay reachable when the EventSub variables are unset.
		// `addEventSubscription` throws a `ReferenceError` in that case, which would otherwise
		// surface as an opaque failure.
		if (!areTwitchEventSubCredentialsSet()) {
			container.logger.error(
				"[twitch-subscriptions] TWITCH_EVENT_SUB_CALLBACK and/or TWITCH_EVENT_SUB_SECRET are not set, EventSub subscriptions cannot be created.",
			);
			return err("commands/twitch:addFailedTwitch");
		}

		const eventSubResult = await Result.fromAsync(() =>
			addEventSubscription(streamer.id, TwitchEventSubTypes[type]),
		);
		if (eventSubResult.isErr()) {
			container.logger.error(
				`[twitch-subscriptions] Failed to create the ${TwitchEventSubTypes[type]} EventSub subscription for ${streamer.id}`,
				eventSubResult.unwrapErr(),
			);
			return err("commands/twitch:addFailedTwitch");
		}

		const subscription = eventSubResult.unwrap();
		if (isNullish(subscription?.id)) {
			container.logger.error(
				`[twitch-subscriptions] Twitch returned an empty EventSub payload for ${streamer.id}`,
			);
			return err("commands/twitch:addFailedTwitch");
		}

		// A single nested write so the `TwitchSubscription` row cannot be created without the
		// `GuildSubscription` row that owns it.
		const createdResult = await Result.fromAsync(() =>
			createGuildSubscription(guildId, channelId, message, {
				create: {
					streamerId: streamer.id,
					subscriptionId: subscription.id,
					subscriptionType: type,
				},
			}),
		);
		if (createdResult.isErr()) {
			container.logger.error(
				"[twitch-subscriptions] Failed to store the subscription, reverting the EventSub subscription",
				createdResult.unwrapErr(),
			);
			// Twitch answers 409 for duplicated subscriptions, so leaving this behind would make the
			// streamer impossible to add ever again.
			const revertedResult = await Result.fromAsync(() =>
				removeEventSubscription(subscription.id),
			);
			if (revertedResult.isErr()) {
				// A rejected delete does not prove Twitch kept the subscription, the response can be lost
				// after it was processed. Persisting a row for a subscription that is actually gone is worse
				// than persisting none: a later add would take the `connect` branch, report success, and then
				// never deliver a notification. Only keep the row once Twitch still lists the subscription.
				const confirmed = await isEventSubSubscriptionListed(
					streamer.id,
					TwitchEventSubTypes[type],
					subscription.id,
				);
				if (!confirmed) {
					container.logger.fatal(
						`[twitch-subscriptions] Could not confirm the ${TwitchEventSubTypes[type]} EventSub subscription "${subscription.id}" for streamer ${streamer.id} after the revert failed, so it was not persisted; if it still exists on Twitch it must be removed manually.`,
						revertedResult.unwrapErr(),
					);
				} else {
					// The subscription is still live on Twitch, so persist the shared row alone: a later add
					// reuses it through the `connect` branch instead of hitting Twitch's 409 forever.
					const recoveryResult = await Result.fromAsync(() =>
						container.prisma.twitchSubscription.create({
							data: {
								streamerId: streamer.id,
								subscriptionId: subscription.id,
								subscriptionType: type,
							},
							select: null,
						}),
					);
					if (recoveryResult.isErr()) {
						// The EventSub subscription is now orphaned: it exists on Twitch with no row pointing at
						// it. Log the id at `fatal` so it can be deleted by hand.
						container.logger.fatal(
							`[twitch-subscriptions] Orphaned ${TwitchEventSubTypes[type]} EventSub subscription "${subscription.id}" for streamer ${streamer.id}: the rollback failed and it must be removed manually.`,
							revertedResult.unwrapErr(),
							recoveryResult.unwrapErr(),
						);
					} else {
						container.logger.error(
							`[twitch-subscriptions] Failed to revert the ${TwitchEventSubTypes[type]} EventSub subscription "${subscription.id}" for streamer ${streamer.id}, persisted it so a later add can reuse it.`,
							revertedResult.unwrapErr(),
						);
					}
				}
			}
			return err("commands/twitch:addFailedDatabase");
		}
	}

	return ok({ streamer });
}

/**
 * Deletes every provided guild subscription and, for each unique shared `TwitchSubscription` they
 * pointed at, removes it (and its EventSub subscription) once nothing else references it.
 *
 * Shared by the `reset` slash command and, later, a component/modal driven UI.
 */
export function resetGuildSubscriptions(
	subscriptions: GuildSubscriptionWithTwitch[],
): Promise<Result<void, unknown>> {
	const uniqueSubscriptionIds = [
		...new Set(subscriptions.map((gs) => gs.subscriptionId)),
	];

	return Result.fromAsync(async () => {
		await Promise.all(subscriptions.map((gs) => deleteSubscription(gs)));
		await Promise.all(
			uniqueSubscriptionIds.map((subscriptionId) =>
				removeSubscription(subscriptionId),
			),
		);
	});
}

/**
 * Sends a one-off preview of a subscription's notification through the exact same delivery
 * helpers the real Twitch listeners use, so a success here proves the real path works.
 *
 * Shared by the `test` slash command and, later, a component/modal driven UI. `"missingMessage"`
 * is returned instead of a `NotificationDeliveryError` when an offline subscription has nothing to
 * send: `add` enforces a message for offline subscriptions, but a row predating that check would
 * leave nothing to send.
 */
export async function testSubscriptionDelivery(
	subscription: GuildSubscriptionWithTwitch,
	streamer: Pick<TwitchHelixUsersSearchResult, "id" | "login" | "display_name">,
): Promise<Result<void, NotificationDeliveryError | "missingMessage">> {
	const target = {
		guildId: subscription.guildId,
		channelId: subscription.channelId,
	};

	// The notification is sent through the very same helpers the listeners use, so a success here
	// proves the real path works. The drip is deliberately skipped: this is an explicit manual
	// action and must neither be suppressed nor consume the bucket of the real notifications.
	if (
		subscription.twitchSubscription.subscriptionType ===
		TwitchSubscriptionType.StreamOnline
	) {
		const streamResult = await Result.fromAsync(() => fetchStream(streamer.id));
		if (streamResult.isErr()) {
			container.logger.debug(
				`[twitch-subscriptions] Could not fetch the stream of ${streamer.id}`,
				streamResult.unwrapErr(),
			);
		}

		const streamData = streamResult.unwrapOr(null);
		container.logger.debug(
			`[twitch-subscriptions] Stream data for ${streamer.id}: ${JSON.stringify(streamData)}`,
		);

		return sendOnlineNotification({
			...target,
			message: subscription.message,
			event: {
				broadcaster_user_id: streamer.id,
				broadcaster_user_login: streamer.login,
				broadcaster_user_name: streamer.display_name,
				id: "0",
				type: "live",
				started_at: new Date(
					streamData?.started_at ?? new Date(),
				).toISOString(),
			},
			streamData,
			testNotice: true,
		});
	}

	// `add` enforces a message for offline subscriptions, but a row predating that check would
	// leave nothing to send.
	if (isNullishOrEmpty(subscription.message)) {
		container.logger.debug(
			`[twitch-subscriptions] Aborted: the offline subscription ${subscription.id} has no message`,
		);
		return err("missingMessage");
	}

	return sendOfflineNotification({
		...target,
		message: subscription.message,
		date: new Date(),
		testNotice: true,
	});
}
