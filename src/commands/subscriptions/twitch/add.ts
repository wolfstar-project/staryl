import type { TwitchEventOptions } from "#utils/twitchCommandOptions";
import { TwitchSubscriptionType } from "#generated/prisma";
import {
	addSubscription,
	createChannelOption,
	createStreamerOption,
	MaximumMessageLength,
	SubscriptionsCommandName,
	TwitchGroupName,
} from "#twitch/subscriptions";
import {
	createTwitchEventOption,
	getTwitchLiveType,
} from "#utils/twitchCommandOptions";
import { runTwitchMediaAction } from "#utils/twitchMediaCommands";
import { channelMention } from "@discordjs/formatters";
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
			.addStringOption(createTwitchEventOption())
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/twitch:optionsMessageName",
					"commands/twitch:optionsMessageDescription",
				)
					.setMaxLength(MaximumMessageLength)
					.setRequired(false),
			)
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/social:optionsKeywordsName",
					"commands/social:optionsKeywordsDescription",
				).setMaxLength(500),
			)
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/social:optionsExcludeKeywordsName",
					"commands/social:optionsExcludeKeywordsDescription",
				).setMaxLength(500),
			),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: TwitchEventOptions,
	) {
		if (options.event === "video" || options.event === "clip") {
			return runTwitchMediaAction(this, interaction, options, "add");
		}

		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		if (options.keywords || options.exclude_keywords)
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/social:addFilterUnsupported",
				),
			});

		const { channel, message } = options;
		const type = getTwitchLiveType(options.event);

		const guildId = BigInt(interaction.guildId!);
		const channelId = BigInt(channel.id);

		const result = await addSubscription(
			guildId,
			channelId,
			options.streamer,
			type,
			message ?? null,
		);
		if (result.isErr()) {
			return deferred.update({
				content: await resolveKey(interaction, result.unwrapErr()),
			});
		}

		const { streamer } = result.unwrap();
		const content = await resolveKey(
			interaction,
			type === TwitchSubscriptionType.StreamOnline
				? "commands/twitch:addSuccessLive"
				: "commands/twitch:addSuccessOffline",
			{
				GREENTICK: "✅",
				name: streamer.display_name,
				channel: channelMention(channel.id),
			},
		);

		return deferred.update({ content });
	}
}
