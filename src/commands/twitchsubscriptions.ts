import type { GuildSubscription, Prisma } from "#lib/setup/prisma";
import type {
	TwitchEventSubResult,
	TwitchHelixResponse,
} from "@wolfstar/twitch-helpers";
import type { APIChannel } from "discord-api-types/v10";
import { TwitchSubscriptionType } from "#generated/prisma";
import { LanguageKeys } from "#i18n";
import {
	EmbedBuilder,
	SlashCommandChannelOption,
	SlashCommandStringOption,
} from "@discordjs/builders";
import { channelMention } from "@discordjs/formatters";
import { Result } from "@sapphire/result";
import { cast, isNullish, isNullishOrEmpty } from "@sapphire/utilities";
import {
	Command,
	RegisterCommand,
	RegisterSubcommand,
} from "@wolfstar/http-framework";
import {
	applyLocalizedBuilder,
	createSelectMenuChoiceName,
	resolveKey,
} from "@wolfstar/http-framework-i18n";
import {
	addEventSubscription,
	areTwitchEventSubCredentialsSet,
	fetchUsers,
	getRequest,
	removeEventSubscription,
	TwitchEventSubTypes,
} from "@wolfstar/twitch-helpers";
import {
	ApplicationIntegrationType,
	ChannelType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
} from "discord-api-types/v10";

const Root = LanguageKeys.Commands.Twitch;

/**
 * Matches the `@db.VarChar(200)` column backing {@link GuildSubscription.message}; without it Discord accepts
 * messages the database rejects, and the insert fails after the Twitch subscription has already been created.
 */
const MaximumMessageLength = 200;

/**
 * The `users` Twitch Helix endpoint accepts at most 100 ids per request.
 */
const MaximumUsersPerRequest = 100;

@RegisterCommand((builder) =>
	applyLocalizedBuilder(builder, Root.RootName, Root.RootDescription)
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
		.setContexts(InteractionContextType.Guild),
)
export class UserCommand extends Command {
	@RegisterSubcommand((builder) =>
		applyLocalizedBuilder(builder, Root.AddName, Root.AddDescription)
			.addStringOption(createStreamerOption(true))
			.addChannelOption(createChannelOption().setRequired(true))
			.addStringOption(createTypeChoiceOption().setRequired(true))
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					Root.OptionsMessageName,
					Root.OptionsMessageDescription,
				)
					.setMaxLength(MaximumMessageLength)
					.setRequired(false),
			),
	)
	public async add(
		interaction: Command.ChatInputInteraction,
		options: Options,
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
					Root.AddMessageForOfflineRequired,
				),
			});
		}

		const streamer = await this.#getStreamer(options.streamer);
		if (isNullish(streamer)) {
			return deferred.update({
				content: await resolveKey(interaction, Root.StreamerNotFound),
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
				content: await resolveKey(interaction, Root.AddFailedDatabase),
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
				content: await resolveKey(interaction, Root.AddDuplicated),
			});
		}

		if (streamerForType) {
			const createdResult = await Result.fromAsync(() =>
				this.#createGuildSubscription(guildId, channelId, message, {
					connect: { id: streamerForType.id },
				}),
			);
			if (createdResult.isErr()) {
				this.container.logger.error(
					"[twitch-subscriptions] Failed to store the guild subscription",
					createdResult.unwrapErr(),
				);
				return deferred.update({
					content: await resolveKey(interaction, Root.AddFailedDatabase),
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
					content: await resolveKey(interaction, Root.AddFailedTwitch),
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
					content: await resolveKey(interaction, Root.AddFailedTwitch),
				});
			}

			const subscription = eventSubResult.unwrap();
			if (isNullish(subscription?.id)) {
				this.container.logger.error(
					`[twitch-subscriptions] Twitch returned an empty EventSub payload for ${streamer.id}`,
				);
				return deferred.update({
					content: await resolveKey(interaction, Root.AddFailedTwitch),
				});
			}

			// A single nested write so the `TwitchSubscription` row cannot be created without the
			// `GuildSubscription` row that owns it.
			const createdResult = await Result.fromAsync(() =>
				this.#createGuildSubscription(guildId, channelId, message, {
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
					const confirmed = await this.#isEventSubSubscriptionListed(
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
					content: await resolveKey(interaction, Root.AddFailedDatabase),
				});
			}
		}

		const content = cast<string>(
			await resolveKey(
				interaction,
				type === TwitchSubscriptionType.StreamOnline
					? Root.AddSuccessLive
					: Root.AddSuccessOffline,
				{ name: streamer.display_name, channel: channelMention(channel.id) },
			),
		);

		return deferred.update({ content });
	}

	@RegisterSubcommand((builder) =>
		applyLocalizedBuilder(builder, Root.RemoveName, Root.RemoveDescription)
			.addStringOption(createStreamerOption(true))
			.addChannelOption(createChannelOption().setRequired(true))
			.addStringOption(createTypeChoiceOption().setRequired(true)),
	)
	public async remove(
		interaction: Command.ChatInputInteraction,
		options: Options,
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		const streamer = await this.#getStreamer(options.streamer);
		if (isNullish(streamer)) {
			return deferred.update({
				content: await resolveKey(interaction, Root.StreamerNotFound),
			});
		}

		const { channel, type: subscriptionType } = options;

		const guildSubscriptionsResult = await this.getGuildSubscriptions(
			BigInt(interaction.guildId!),
		);
		if (guildSubscriptionsResult.isErr()) {
			this.container.logger.error(
				"[twitch-subscriptions] Failed to read the guild subscriptions",
				guildSubscriptionsResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, Root.RemoveFailed),
			});
		}
		const guildSubscriptions = guildSubscriptionsResult.unwrap();

		const streamers = guildSubscriptions.filter(
			({ twitchSubscription }) => twitchSubscription.streamerId === streamer.id,
		);

		if (!streamers.length) {
			return deferred.update({
				content: cast<string>(
					await resolveKey(interaction, Root.RemoveStreamerNotSubscribed, {
						streamer: streamer.display_name,
					}),
				),
			});
		}

		const statuses = streamers.filter(
			({ twitchSubscription }) =>
				twitchSubscription.subscriptionType === subscriptionType,
		);

		if (!statuses.length) {
			const showStatuses = await resolveKey(interaction, Root.ShowStatus);
			return deferred.update({
				content: cast<string>(
					await resolveKey(interaction, Root.RemoveStreamerStatusNotMatch, {
						streamer: streamer.display_name,
						status: this.getSubscriptionStatus(subscriptionType, showStatuses),
					}),
				),
			});
		}

		const streamerWithStatusHasChannel = statuses.find(
			(guildSubscription) => guildSubscription.channelId === BigInt(channel.id),
		);

		if (!streamerWithStatusHasChannel) {
			return deferred.update({
				content: cast<string>(
					await resolveKey(interaction, Root.RemoveNotToProvidedChannel, {
						channel: channelMention(channel.id),
					}),
				),
			});
		}

		const removalResult = await Result.fromAsync(async () => {
			await this.#deleteSubscription(streamerWithStatusHasChannel);
			await this.#removeSubscription(
				streamerWithStatusHasChannel.subscriptionId,
			);
		});
		if (removalResult.isErr()) {
			this.container.logger.error(
				"[twitch-subscriptions] Failed to remove the subscription",
				removalResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, Root.RemoveFailed),
			});
		}

		const content = cast<string>(
			await resolveKey(
				interaction,
				subscriptionType === TwitchSubscriptionType.StreamOnline
					? Root.RemoveSuccessLive
					: Root.RemoveSuccessOffline,
				{ name: streamer.display_name, channel: channelMention(channel.id) },
			),
		);
		return deferred.update({ content });
	}

	@RegisterSubcommand((builder) =>
		applyLocalizedBuilder(
			builder,
			Root.ResetName,
			Root.ResetDescription,
		).addStringOption(createStreamerOption(false)),
	)
	public async reset(
		interaction: Command.ChatInputInteraction,
		options: ResetShowOptions,
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		const guildId = BigInt(interaction.guildId!);

		const guildSubscriptionsResult = await this.getGuildSubscriptions(guildId);
		if (guildSubscriptionsResult.isErr()) {
			this.container.logger.error(
				"[twitch-subscriptions] Failed to read the guild subscriptions",
				guildSubscriptionsResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, Root.ResetFailed),
			});
		}

		let guildSubscriptions = guildSubscriptionsResult.unwrap();

		if (!guildSubscriptions.length) {
			return deferred.update({
				content: await resolveKey(interaction, Root.NoSubscriptions),
			});
		}

		if (!isNullish(options.streamer)) {
			const streamer = await this.#getStreamer(options.streamer);
			if (isNullish(streamer)) {
				return deferred.update({
					content: await resolveKey(interaction, Root.StreamerNotFound),
				});
			}
			guildSubscriptions = guildSubscriptions.filter(
				(gs) => gs.twitchSubscription.streamerId === streamer.id,
			);
		}

		if (!guildSubscriptions.length) {
			return deferred.update({
				content: await resolveKey(interaction, Root.NoSubscriptions),
			});
		}

		const count = guildSubscriptions.length;
		const uniqueSubscriptionIds = [
			...new Set(guildSubscriptions.map((gs) => gs.subscriptionId)),
		];

		const removalResult = await Result.fromAsync(async () => {
			await Promise.all(
				guildSubscriptions.map((gs) => this.#deleteSubscription(gs)),
			);
			await Promise.all(
				uniqueSubscriptionIds.map((subscriptionId) =>
					this.#removeSubscription(subscriptionId),
				),
			);
		});
		if (removalResult.isErr()) {
			this.container.logger.error(
				"[twitch-subscriptions] Failed to reset the subscriptions",
				removalResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, Root.ResetFailed),
			});
		}

		const content = cast<string>(
			await resolveKey(interaction, Root.ResetSuccess, { count }),
		);
		return deferred.update({ content });
	}

	@RegisterSubcommand((builder) =>
		applyLocalizedBuilder(
			builder,
			Root.ShowName,
			Root.ShowDescription,
		).addStringOption(createStreamerOption(false)),
	)
	public async show(
		interaction: Command.ChatInputInteraction,
		options: ResetShowOptions,
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		const guildId = BigInt(interaction.guildId!);

		const guildSubscriptionsResult = await this.getGuildSubscriptions(guildId);
		if (guildSubscriptionsResult.isErr()) {
			this.container.logger.error(
				"[twitch-subscriptions] Failed to read the guild subscriptions",
				guildSubscriptionsResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, Root.NoSubscriptions),
			});
		}

		const allSubscriptions = guildSubscriptionsResult.unwrap();

		if (!allSubscriptions.length) {
			return deferred.update({
				content: await resolveKey(interaction, Root.NoSubscriptions),
			});
		}

		let streamerFilter: { id: string; display_name: string } | null = null;
		if (!isNullish(options.streamer)) {
			streamerFilter = await this.#getStreamer(options.streamer);
			if (isNullish(streamerFilter)) {
				return deferred.update({
					content: await resolveKey(interaction, Root.StreamerNotFound),
				});
			}
		}

		const subscriptions = streamerFilter
			? allSubscriptions.filter(
					(gs) => gs.twitchSubscription.streamerId === streamerFilter!.id,
				)
			: allSubscriptions;

		if (!subscriptions.length) {
			return deferred.update({
				content: await resolveKey(interaction, Root.ShowStreamerNotSubscribed),
			});
		}

		const [statuses, unknownUser] = await Promise.all([
			resolveKey(interaction, Root.ShowStatus),
			resolveKey(interaction, Root.ShowUnknownUser),
		]);

		const names = streamerFilter
			? new Map([[streamerFilter.id, streamerFilter.display_name]])
			: await this.#fetchStreamerNames(
					subscriptions.map((gs) => gs.twitchSubscription.streamerId),
				);

		const lines = subscriptions.map((gs) => {
			const name = names.get(gs.twitchSubscription.streamerId) ?? unknownUser;
			const status = this.getSubscriptionStatus(
				gs.twitchSubscription.subscriptionType,
				statuses,
			);
			return `${name} — ${channelMention(String(gs.channelId))} → ${status}`;
		});

		const embed = new EmbedBuilder()
			.setTitle(await resolveKey(interaction, Root.ShowEmbedTitle))
			.setDescription(lines.join("\n"));
		return deferred.update({ embeds: [embed.toJSON()] });
	}

	public override async autocompleteRun(
		interaction: Command.AutocompleteInteraction,
		args: Command.AutocompleteArguments<{ streamer: string }>,
	) {
		if (args.focused !== "streamer") return interaction.replyEmpty();

		const query = args.streamer ?? "";
		if (!query.length) return interaction.replyEmpty();

		const result = await getRequest<
			TwitchHelixResponse<TwitchChannelSearchResult>
		>(`search/channels?query=${encodeURIComponent(query)}&first=25`);
		if (result.isErr()) return interaction.replyEmpty();

		const { data } = result.unwrap();
		return interaction.reply({
			choices: data.map((channel) => ({
				name: channel.display_name,
				value: channel.broadcaster_login,
			})),
		});
	}

	private getGuildSubscriptions(guildId: bigint) {
		return Result.fromAsync(() =>
			this.container.prisma.guildSubscription.findMany({
				where: { guildId },
				include: { twitchSubscription: true },
			}),
		);
	}

	private getSubscriptionStatus(
		subscription: TwitchSubscriptionType,
		statuses: { live: string; offline: string },
	) {
		return subscription === TwitchSubscriptionType.StreamOnline
			? statuses.live
			: statuses.offline;
	}

	#createGuildSubscription(
		guildId: bigint,
		channelId: bigint,
		message: string | null,
		twitchSubscription: Prisma.TwitchSubscriptionCreateNestedOneWithoutGuildSubscriptionInput,
	) {
		return this.container.prisma.guildSubscription.create({
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
	async #isEventSubSubscriptionListed(
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
				this.container.logger.error(
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

	async #getStreamer(streamerName: string) {
		// `Result.fromAsync` flattens the returned `FetchResult` and additionally catches the errors
		// `fetchUsers` throws when the Twitch client credentials are missing.
		const result = await Result.fromAsync(() =>
			fetchUsers({ logins: [streamerName] }),
		);
		if (result.isErr()) {
			this.container.logger.error(
				`[twitch-subscriptions] Failed to look up the streamer "${streamerName}"`,
				result.unwrapErr(),
			);
			return null;
		}

		const { data } = result.unwrap();
		return data.length > 0 ? data[0] : null;
	}

	async #fetchStreamerNames(streamerIds: readonly string[]) {
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
				this.container.logger.error(
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

	async #deleteSubscription(subscription: GuildSubscription) {
		await this.container.prisma.guildSubscription.delete({
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

	async #removeSubscription(subscriptionId: bigint): Promise<void> {
		const twitchSubscription =
			await this.container.prisma.twitchSubscription.findFirst({
				where: { id: subscriptionId },
				include: { guildSubscription: true },
			});
		if (!twitchSubscription) return;
		if (twitchSubscription.guildSubscription.length === 0) {
			await removeEventSubscription(twitchSubscription.subscriptionId);
			await this.container.prisma.twitchSubscription.delete({
				where: { id: subscriptionId },
				select: null,
			});
		}
	}
}

interface Options {
	streamer: string;
	channel: APIChannel;
	type: TwitchSubscriptionType;
	message: string | null;
}

interface ResetShowOptions {
	streamer?: string;
}

function createTypeChoiceOption() {
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

function createChannelOption() {
	return applyLocalizedBuilder(
		new SlashCommandChannelOption(),
		Root.OptionsChannelName,
		Root.OptionsChannelDescription,
	).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
}

function createStreamerOption(required: boolean) {
	return applyLocalizedBuilder(
		new SlashCommandStringOption(),
		Root.OptionsStreamerName,
		Root.OptionsStreamerDescription,
	)
		.setRequired(required)
		.setAutocomplete(true);
}

interface TwitchChannelSearchResult {
	broadcaster_login: string;
	display_name: string;
	id: string;
	is_live: boolean;
}
