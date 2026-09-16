import type { TwitchSubscriptionOptions } from "#utils/twitch/subscriptions";
import { TwitchSubscriptionType } from "#generated/prisma";
import {
	addSubscription,
	createChannelOption,
	createStreamerOption,
	createTypeChoiceOption,
	MaximumMessageLength,
	SubscriptionsCommandName,
	TwitchGroupName,
} from "#utils/twitch/subscriptions";
import { channelMention } from "@discordjs/formatters";
import { cast } from "@sapphire/utilities";
import {
	applyLocalizedBuilder,
	getSupportedLanguageT as resolveKey,
} from "@wolfstar/plugin-i18next";
import {
	Command,
	RegisterAsSubcommandGroup,
} from "@wolfstar/plugin-subcommands-advanced";
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

		const guildId = BigInt(interaction.guildId!);
		const channelId = BigInt(channel.id);

		const result = await addSubscription(
			guildId,
			channelId,
			options.streamer,
			type,
			message,
		);
		if (result.isErr()) {
			return deferred.update({
				content: await resolveKey(interaction, result.unwrapErr()),
			});
		}

		const { streamer } = result.unwrap();
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
