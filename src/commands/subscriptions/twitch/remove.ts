import type { TwitchSubscriptionOptions } from "#utils/twitchSubscriptions";
import { TwitchSubscriptionType } from "#generated/prisma";
import { LanguageKeys } from "#i18n";
import {
	createChannelOption,
	createStreamerOption,
	createTypeChoiceOption,
	deleteSubscription,
	getStreamer,
	removeSubscription,
	resolveSubscription,
	SubscriptionsCommandName,
	TwitchGroupName,
} from "#utils/twitchSubscriptions";
import { channelMention } from "@discordjs/formatters";
import { Result } from "@sapphire/result";
import { cast, isNullish } from "@sapphire/utilities";
import { applyLocalizedBuilder, resolveKey } from "@wolfstar/plugin-i18next";
import {
	Command,
	RegisterAsSubcommandGroup,
} from "@wolfstar/plugin-subcommands-advanced";
import { MessageFlags } from "discord-api-types/v10";

const Root = LanguageKeys.Commands.Twitch;

@RegisterAsSubcommandGroup(
	SubscriptionsCommandName,
	TwitchGroupName,
	(builder) =>
		applyLocalizedBuilder(builder, Root.RemoveName, Root.RemoveDescription)
			.addStringOption(createStreamerOption(true))
			.addChannelOption(createChannelOption().setRequired(true))
			.addStringOption(createTypeChoiceOption().setRequired(true)),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: TwitchSubscriptionOptions,
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		const streamer = await getStreamer(options.streamer);
		if (isNullish(streamer)) {
			return deferred.update({
				content: await resolveKey(interaction, Root.StreamerNotFound),
			});
		}

		const { channel, type: subscriptionType } = options;

		const subscriptionResult = await resolveSubscription(
			interaction,
			streamer,
			channel,
			subscriptionType,
			Root.RemoveFailed,
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
}
