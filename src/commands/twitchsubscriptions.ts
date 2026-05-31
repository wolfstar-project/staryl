import type { GuildSubscription } from "#lib/setup/prisma";
import type { TwitchHelixResponse } from "@skyra/twitch-helpers";
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
} from "@skyra/http-framework";
import {
	applyLocalizedBuilder,
	createSelectMenuChoiceName,
	resolveKey,
} from "@skyra/http-framework-i18n";
import {
	addEventSubscription,
	fetchUsers,
	getRequest,
	removeEventSubscription,
	TwitchEventSubTypes,
} from "@skyra/twitch-helpers";
import {
	ApplicationIntegrationType,
	ChannelType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
} from "discord-api-types/v10";

const Root = LanguageKeys.Commands.Twitch;

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
				).setRequired(false),
			),
	)
	public async add(
		interaction: Command.ChatInputInteraction,
		options: Options,
	) {
		const { channel, type, message, streamer: streamerRaw } = options;
		const streamer = await this.#getStreamer(streamerRaw);
		if (!streamer) {
			return interaction.reply({
				content: await resolveKey(
					interaction,
					LanguageKeys.Commands.Twitch.StreamerNotFound,
				),
				flags: MessageFlags.Ephemeral,
			});
		}

		if (
			type === TwitchSubscriptionType.StreamOffline &&
			isNullishOrEmpty(message)
		) {
			return interaction.reply({
				content: await resolveKey(
					interaction,
					LanguageKeys.Commands.Twitch.AddMessageForOfflineRequired,
				),
				flags: MessageFlags.Ephemeral,
			});
		}

		const streamerForType =
			await this.container.prisma.twitchSubscription.findFirst({
				where: { streamerId: streamer.id, subscriptionType: type },
			});

		const guildSubscriptionsForGuild =
			await this.container.prisma.guildSubscription.findMany({
				where: {
					guildId: BigInt(interaction.guildId!),
					channelId: BigInt(channel.id),
				},
				include: { twitchSubscription: true },
			});

		const alreadyHasEntry = guildSubscriptionsForGuild.some(
			(guildSubscription) =>
				guildSubscription.twitchSubscription.streamerId === streamer.id &&
				guildSubscription.twitchSubscription.subscriptionType === type,
		);

		if (alreadyHasEntry) {
			return interaction.reply({
				content: await resolveKey(
					interaction,
					LanguageKeys.Commands.Twitch.AddDuplicated,
				),
				flags: MessageFlags.Ephemeral,
			});
		}

		if (streamerForType) {
			await this.container.prisma.guildSubscription.create({
				data: {
					channelId: BigInt(channel.id),
					message: message ?? undefined,
					guild: {
						connectOrCreate: {
							where: { id: BigInt(interaction.guildId!) },
							create: { id: BigInt(interaction.guildId!) },
						},
					},
					twitchSubscription: { connect: { id: streamerForType.id } },
				},
				select: null,
			});
		} else {
			const subscription = await addEventSubscription(
				streamer.id,
				TwitchEventSubTypes[type],
			);
			await this.container.prisma.guildSubscription.create({
				data: {
					channelId: BigInt(channel.id),
					message: message ?? undefined,
					guild: {
						connectOrCreate: {
							where: { id: BigInt(interaction.guildId!) },
							create: { id: BigInt(interaction.guildId!) },
						},
					},
					twitchSubscription: { connect: { id: Number(subscription.id) } },
				},
				select: null,
			});
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

		return interaction.reply({ content, flags: MessageFlags.Ephemeral });
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
		const streamer = await this.#getStreamer(options.streamer);
		if (!streamer) {
			return interaction.reply({
				content: await resolveKey(
					interaction,
					LanguageKeys.Commands.Twitch.StreamerNotFound,
				),
				flags: MessageFlags.Ephemeral,
			});
		}

		const { channel, type: subscriptionType } = options;

		const guildSubscriptionsResult = await this.getGuildSubscriptions(
			BigInt(interaction.guildId!),
		);
		if (guildSubscriptionsResult.isErr()) {
			return interaction.reply({
				content:
					"An error occurred while trying to remove the subscription. Please try again later.",
				flags: MessageFlags.Ephemeral,
			});
		}
		const guildSubscriptions = guildSubscriptionsResult.unwrap();

		const streamers = guildSubscriptions.filter(
			({ twitchSubscription }) => twitchSubscription.streamerId === streamer.id,
		);

		if (!streamers.length) {
			return interaction.reply({
				content: cast<string>(
					await resolveKey(
						interaction,
						LanguageKeys.Commands.Twitch.RemoveStreamerNotSubscribed,
						{
							streamer: streamer.display_name,
						},
					),
				),
				flags: MessageFlags.Ephemeral,
			});
		}

		const statuses = streamers.filter(
			({ twitchSubscription }) =>
				twitchSubscription.subscriptionType === subscriptionType,
		);

		if (!statuses.length) {
			const showStatuses = await resolveKey(interaction, Root.ShowStatus);
			return interaction.reply({
				content: cast<string>(
					await resolveKey(
						interaction,
						LanguageKeys.Commands.Twitch.RemoveStreamerStatusNotMatch,
						{
							streamer: streamer.display_name,
							status: this.getSubscriptionStatus(
								subscriptionType,
								showStatuses,
							),
						},
					),
				),
				flags: MessageFlags.Ephemeral,
			});
		}

		const streamerWithStatusHasChannel = statuses.find(
			(guildSubscription) => guildSubscription.channelId === BigInt(channel.id),
		);

		if (!streamerWithStatusHasChannel) {
			return interaction.reply({
				content: cast<string>(
					await resolveKey(
						interaction,
						LanguageKeys.Commands.Twitch.RemoveNotToProvidedChannel,
						{ channel: channelMention(channel.id) },
					),
				),
				flags: MessageFlags.Ephemeral,
			});
		}

		try {
			await this.#deleteSubscription(streamerWithStatusHasChannel);
			await this.#removeSubscription(
				streamerWithStatusHasChannel.subscriptionId,
			);
		} catch {
			return interaction.reply({
				content:
					"An error occurred while trying to remove the subscription. Please try again later.",
				flags: MessageFlags.Ephemeral,
			});
		}

		const content = cast<string>(
			await resolveKey(
				interaction,
				subscriptionType === TwitchSubscriptionType.StreamOnline
					? LanguageKeys.Commands.Twitch.RemoveSuccessLive
					: LanguageKeys.Commands.Twitch.RemoveSuccessOffline,
				{ name: streamer.display_name, channel: channelMention(channel.id) },
			),
		);
		return interaction.reply({ content, flags: MessageFlags.Ephemeral });
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
		const guildId = BigInt(interaction.guildId!);

		const guildSubscriptionsResult = await this.getGuildSubscriptions(guildId);
		if (guildSubscriptionsResult.isErr()) {
			return interaction.reply({
				content: await resolveKey(interaction, Root.NoSubscriptions),
				flags: MessageFlags.Ephemeral,
			});
		}

		let guildSubscriptions = guildSubscriptionsResult.unwrap();

		if (!guildSubscriptions.length) {
			return interaction.reply({
				content: await resolveKey(interaction, Root.NoSubscriptions),
				flags: MessageFlags.Ephemeral,
			});
		}

		if (!isNullish(options.streamer)) {
			const streamer = await this.#getStreamer(options.streamer);
			if (!streamer) {
				return interaction.reply({
					content: await resolveKey(interaction, Root.StreamerNotFound),
					flags: MessageFlags.Ephemeral,
				});
			}
			guildSubscriptions = guildSubscriptions.filter(
				(gs) => gs.twitchSubscription.streamerId === streamer.id,
			);
		}

		if (!guildSubscriptions.length) {
			return interaction.reply({
				content: await resolveKey(interaction, Root.NoSubscriptions),
				flags: MessageFlags.Ephemeral,
			});
		}

		const count = guildSubscriptions.length;
		const uniqueSubscriptionIds = [
			...new Set(guildSubscriptions.map((gs) => gs.subscriptionId)),
		];

		await Promise.all(
			guildSubscriptions.map((gs) => this.#deleteSubscription(gs)),
		);
		await Promise.all(
			uniqueSubscriptionIds.map((subscriptionId) =>
				this.#removeSubscription(subscriptionId),
			),
		);

		const content = cast<string>(
			await resolveKey(interaction, Root.ResetSuccess, { count }),
		);
		return interaction.reply({ content, flags: MessageFlags.Ephemeral });
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
		const guildId = BigInt(interaction.guildId!);

		const guildSubscriptionsResult = await this.getGuildSubscriptions(guildId);
		if (guildSubscriptionsResult.isErr()) {
			return interaction.reply({
				content: await resolveKey(interaction, Root.NoSubscriptions),
				flags: MessageFlags.Ephemeral,
			});
		}

		const allSubscriptions = guildSubscriptionsResult.unwrap();

		if (!allSubscriptions.length) {
			return interaction.reply({
				content: await resolveKey(interaction, Root.NoSubscriptions),
				flags: MessageFlags.Ephemeral,
			});
		}

		let streamerFilter: { id: string; display_name: string } | null = null;
		if (!isNullish(options.streamer)) {
			streamerFilter = await this.#getStreamer(options.streamer);
			if (!streamerFilter) {
				return interaction.reply({
					content: await resolveKey(interaction, Root.StreamerNotFound),
					flags: MessageFlags.Ephemeral,
				});
			}
		}

		const subscriptions = streamerFilter
			? allSubscriptions.filter(
					(gs) => gs.twitchSubscription.streamerId === streamerFilter!.id,
				)
			: allSubscriptions;

		if (!subscriptions.length) {
			return interaction.reply({
				content: await resolveKey(interaction, Root.ShowStreamerNotSubscribed),
				flags: MessageFlags.Ephemeral,
			});
		}

		const [statuses, unknownUser] = await Promise.all([
			resolveKey(interaction, Root.ShowStatus),
			resolveKey(interaction, Root.ShowUnknownUser),
		]);

		let names: Map<string, string>;
		if (streamerFilter) {
			names = new Map([[streamerFilter.id, streamerFilter.display_name]]);
		} else {
			const streamerIds = [
				...new Set(subscriptions.map((gs) => gs.twitchSubscription.streamerId)),
			];
			const profilesResult = await fetchUsers({ ids: streamerIds });
			names = profilesResult.isOk()
				? new Map(
						profilesResult.unwrap().data.map((p) => [p.id, p.display_name]),
					)
				: new Map();
		}

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
		return interaction.reply({
			embeds: [embed.toJSON()],
			flags: MessageFlags.Ephemeral,
		});
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

	async #getStreamer(streamerName: string) {
		const { data } = (await fetchUsers({ logins: [streamerName] })).unwrapRaw();
		if (data.length > 0) return data[0];
		return null;
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
