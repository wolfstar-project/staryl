import type { TwitchSubscriptionOptions } from "#utils/twitchSubscriptions";
import { TwitchSubscriptionType } from "#generated/prisma";
import {
	createChannelOption,
	createGuildSubscription,
	createStreamerOption,
	createTypeChoiceOption,
	getStreamer,
	isEventSubSubscriptionListed,
	MaximumMessageLength,
	SubscriptionsCommandName,
	TwitchGroupName,
} from "#utils/twitchSubscriptions";
import { channelMention } from "@discordjs/formatters";
import { Result } from "@sapphire/result";
import { cast, isNullish, isNullishOrEmpty } from "@sapphire/utilities";
import {
	applyLocalizedBuilder,
	getSupportedLanguageT as resolveKey,
} from "@wolfstar/plugin-i18next";
import {
	Command,
	RegisterAsSubcommandGroup,
} from "@wolfstar/plugin-subcommands-advanced";
import {
	addEventSubscription,
	areTwitchEventSubCredentialsSet,
	removeEventSubscription,
	TwitchEventSubTypes,
} from "@wolfstar/twitch-helpers";
import { MessageFlags } from "discord-api-types/v10";

@RegisterAsSubcommandGroup(
	SubscriptionsCommandName,
	TwitchGroupName,
	(builder) =>
		applyLocalizedBuilder(
			builder,
			"commands/twitch:addName",
			"commands/twitch:addDescription",
		)
			.addStringOption(createStreamerOption(true))
			.addChannelOption(createChannelOption().setRequired(true))
			.addStringOption(createTypeChoiceOption().setRequired(true))
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/twitch:optionsMessageName",
					"commands/twitch:optionsMessageDescription",
				)
					.setMaxLength(MaximumMessageLength)
					.setRequired(false),
			),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: TwitchSubscriptionOptions,
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		const { channel, type, message } = options;

		if (
			type === TwitchSubscriptionType.StreamOffline &&
			isNullishOrEmpty(message)
		) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/twitch:addMessageForOfflineRequired",
				),
			});
		}

		const streamer = await getStreamer(options.streamer);
		if (isNullish(streamer)) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/twitch:streamerNotFound",
				),
			});
		}

		const guildId = BigInt(interaction.guildId!);
		const channelId = BigInt(channel.id);

		const existingResult = await Result.fromAsync(() =>
			Promise.all([
				this.container.prisma.twitchSubscription.findFirst({
					where: { streamerId: streamer.id, subscriptionType: type },
				}),
				this.container.prisma.guildSubscription.findMany({
					where: { guildId, channelId },
					include: { twitchSubscription: true },
				}),
			]),
		);
		if (existingResult.isErr()) {
			this.container.logger.error(
				"[twitch-subscriptions] Failed to read the existing subscriptions",
				existingResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/twitch:addFailedDatabase",
				),
			});
		}

		const [streamerForType, guildSubscriptionsForChannel] =
			existingResult.unwrap();

		const alreadyHasEntry = guildSubscriptionsForChannel.some(
			(guildSubscription) =>
				guildSubscription.twitchSubscription.streamerId === streamer.id &&
				guildSubscription.twitchSubscription.subscriptionType === type,
		);

		if (alreadyHasEntry) {
			return deferred.update({
				content: await resolveKey(interaction, "commands/twitch:addDuplicated"),
			});
		}

		if (streamerForType) {
			const createdResult = await Result.fromAsync(() =>
				createGuildSubscription(guildId, channelId, message, {
					connect: { id: streamerForType.id },
				}),
			);
			if (createdResult.isErr()) {
				this.container.logger.error(
					"[twitch-subscriptions] Failed to store the guild subscription",
					createdResult.unwrapErr(),
				);
				return deferred.update({
					content: await resolveKey(
						interaction,
						"commands/twitch:addFailedDatabase",
					),
				});
			}
		} else {
			// Only this branch talks to Twitch; the branch above merely connects an already existing
			// subscription, so it must stay reachable when the EventSub variables are unset.
			// `addEventSubscription` throws a `ReferenceError` in that case, which would otherwise
			// surface as an opaque failure.
			if (!areTwitchEventSubCredentialsSet()) {
				this.container.logger.error(
					"[twitch-subscriptions] TWITCH_EVENT_SUB_CALLBACK and/or TWITCH_EVENT_SUB_SECRET are not set, EventSub subscriptions cannot be created.",
				);
				return deferred.update({
					content: await resolveKey(
						interaction,
						"commands/twitch:addFailedTwitch",
					),
				});
			}

			const eventSubResult = await Result.fromAsync(() =>
				addEventSubscription(streamer.id, TwitchEventSubTypes[type]),
			);
			if (eventSubResult.isErr()) {
				this.container.logger.error(
					`[twitch-subscriptions] Failed to create the ${TwitchEventSubTypes[type]} EventSub subscription for ${streamer.id}`,
					eventSubResult.unwrapErr(),
				);
				return deferred.update({
					content: await resolveKey(
						interaction,
						"commands/twitch:addFailedTwitch",
					),
				});
			}

			const subscription = eventSubResult.unwrap();
			if (isNullish(subscription?.id)) {
				this.container.logger.error(
					`[twitch-subscriptions] Twitch returned an empty EventSub payload for ${streamer.id}`,
				);
				return deferred.update({
					content: await resolveKey(
						interaction,
						"commands/twitch:addFailedTwitch",
					),
				});
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
				this.container.logger.error(
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
						this.container.logger.fatal(
							`[twitch-subscriptions] Could not confirm the ${TwitchEventSubTypes[type]} EventSub subscription "${subscription.id}" for streamer ${streamer.id} after the revert failed, so it was not persisted; if it still exists on Twitch it must be removed manually.`,
							revertedResult.unwrapErr(),
						);
					} else {
						// The subscription is still live on Twitch, so persist the shared row alone: a later add
						// reuses it through the `connect` branch instead of hitting Twitch's 409 forever.
						const recoveryResult = await Result.fromAsync(() =>
							this.container.prisma.twitchSubscription.create({
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
							this.container.logger.fatal(
								`[twitch-subscriptions] Orphaned ${TwitchEventSubTypes[type]} EventSub subscription "${subscription.id}" for streamer ${streamer.id}: the rollback failed and it must be removed manually.`,
								revertedResult.unwrapErr(),
								recoveryResult.unwrapErr(),
							);
						} else {
							this.container.logger.error(
								`[twitch-subscriptions] Failed to revert the ${TwitchEventSubTypes[type]} EventSub subscription "${subscription.id}" for streamer ${streamer.id}, persisted it so a later add can reuse it.`,
								revertedResult.unwrapErr(),
							);
						}
					}
				}
				return deferred.update({
					content: await resolveKey(
						interaction,
						"commands/twitch:addFailedDatabase",
					),
				});
			}
		}

		const content = cast<string>(
			await resolveKey(
				interaction,
				type === TwitchSubscriptionType.StreamOnline
					? "commands/twitch:addSuccessLive"
					: "commands/twitch:addSuccessOffline",
				{ name: streamer.display_name, channel: channelMention(channel.id) },
			),
		);

		return deferred.update({ content });
	}
}
