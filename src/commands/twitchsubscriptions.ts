import type { GuildSubscription } from "#lib/setup/prisma";
import type { APIChannel } from "discord-api-types/v10";
import { LanguageKeys } from "#i18n";
import { TwitchSubscriptionType } from "#lib/setup/prisma";
import {
	SlashCommandChannelOption,
	SlashCommandStringOption,
} from "@discordjs/builders";
import { channelMention } from "@discordjs/formatters";
import { Result } from "@sapphire/result";
import { cast, isNullishOrEmpty } from "@sapphire/utilities";
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
	TwitchEventSubTypes,
} from "@skyra/twitch-helpers";
import {
	ApplicationIntegrationType,
	ChannelType,
	InteractionContextType,
} from "discord-api-types/v10";
import { MessageFlags, PermissionFlagsBits } from "discord-api-types/v10";

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
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					Root.OptionsStreamerName,
					Root.OptionsStreamerDescription,
				).setRequired(true),
			)
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
					guildId: BigInt(interaction.guildId!),
					channelId: BigInt(channel.id),
					message,
					subscriptionId: streamerForType.id,
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
					guildId: BigInt(interaction.guildId!),
					channelId: BigInt(channel.id),
					message,
					subscriptionId: Number(subscription.id),
				},
				select: null,
			});
		}

		const content = cast<string>(
			resolveKey(
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
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					Root.OptionsStreamerName,
					Root.OptionsStreamerDescription,
				).setRequired(true),
			)
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

		const { channel } = options;
		const subscriptionType = options.type as TwitchSubscriptionType;

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
			return interaction.reply({
				content: cast<string>(
					await resolveKey(
						interaction,
						LanguageKeys.Commands.Twitch.RemoveStreamerStatusNotMatch,
						{
							streamer: streamer.display_name,
							status: this.getSubscriptionStatus(subscriptionType),
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
				subscriptionType === "StreamOnline"
					? LanguageKeys.Commands.Twitch.RemoveSuccessLive
					: LanguageKeys.Commands.Twitch.RemoveSuccessOffline,
				{ name: streamer.display_name, channel: channelMention(channel.id) },
			),
		);
		return interaction.reply({ content, flags: MessageFlags.Ephemeral });
	}

	private getGuildSubscriptions(guildId: bigint) {
		return Result.fromAsync(() =>
			this.container.prisma.guildSubscription.findMany({
				where: { guildId },
				include: { twitchSubscription: true },
			}),
		);
	}

	private getSubscriptionStatus(subscription: TwitchSubscriptionType) {
		return subscription === "StreamOnline" ? "Live" : "Offline";
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

	async #removeSubscription(subscription: bigint) {
		await this.container.prisma.twitchSubscription.delete({
			where: { id: subscription },
			select: null,
		});
	}
}

interface Options {
	streamer: string;
	channel: APIChannel;
	type: TwitchSubscriptionType;
	message: string;
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
