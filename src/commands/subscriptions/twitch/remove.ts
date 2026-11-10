import type { TwitchEventOptions } from "#utils/twitchCommandOptions";
import { TwitchSubscriptionType } from "#generated/prisma";
import {
	createChannelOption,
	createStreamerOption,
	deleteSubscription,
	getStreamer,
	removeSubscription,
	resolveSubscription,
	SubscriptionsCommandName,
	TwitchGroupName,
} from "#twitch/subscriptions";
import {
	createTwitchEventOption,
	getTwitchLiveType,
} from "#utils/twitchCommandOptions";
import { runTwitchMediaAction } from "#utils/twitchMediaCommands";
import { channelMention } from "@discordjs/formatters";
import { Result } from "@sapphire/result";
import { isNullish } from "@sapphire/utilities";
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
			"commands/twitch:removeName",
			"commands/twitch:removeDescription",
		)
			.addStringOption(createStreamerOption(true))
			.addChannelOption(createChannelOption().setRequired(true))
			.addStringOption(createTwitchEventOption()),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: TwitchEventOptions,
	) {
		if (options.event === "video" || options.event === "clip") {
			return runTwitchMediaAction(this, interaction, options, "remove");
		}

		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		const streamer = await getStreamer(options.streamer);
		if (isNullish(streamer)) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/twitch:streamerNotFound",
				),
			});
		}

		const { channel } = options;
		const subscriptionType = getTwitchLiveType(options.event);

		const subscriptionResult = await resolveSubscription(
			interaction,
			streamer,
			channel,
			subscriptionType,
			"commands/twitch:removeFailed",
		);
		if (subscriptionResult.isErr()) {
			return deferred.update({ content: subscriptionResult.unwrapErr() });
		}

		const streamerWithStatusHasChannel = subscriptionResult.unwrap();

		const removalResult = await Result.fromAsync(async () => {
			await deleteSubscription(streamerWithStatusHasChannel);
			await removeSubscription(streamerWithStatusHasChannel.subscriptionId);
		});
		if (removalResult.isErr()) {
			this.container.logger.error(
				"[twitch-subscriptions] Failed to remove the subscription",
				removalResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, "commands/twitch:removeFailed"),
			});
		}

		const content = await resolveKey(
			interaction,
			subscriptionType === TwitchSubscriptionType.StreamOnline
				? "commands/twitch:removeSuccessLive"
				: "commands/twitch:removeSuccessOffline",
			{
				GREENTICK: "✅",
				name: streamer.display_name,
				channel: channelMention(channel.id),
			},
		);

		return deferred.update({ content });
	}
}
