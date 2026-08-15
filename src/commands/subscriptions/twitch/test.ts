import type { NotificationDeliveryError } from "#utils/twitchNotifications";
import type { TwitchSubscriptionOptions } from "#utils/twitchSubscriptions";
import { TwitchSubscriptionType } from "#generated/prisma";
import { LanguageKeys } from "#i18n";
import {
	sendOfflineNotification,
	sendOnlineNotification,
} from "#utils/twitchNotifications";
import {
	createChannelOption,
	createStreamerOption,
	createTypeChoiceOption,
	DeliveryErrorKeys,
	getStreamer,
	resolveSubscription,
	SubscriptionsCommandName,
	TwitchGroupName,
} from "#utils/twitchSubscriptions";
import { channelMention } from "@discordjs/formatters";
import { Result } from "@sapphire/result";
import { cast, isNullish, isNullishOrEmpty } from "@sapphire/utilities";
import {
	applyLocalizedBuilder,
	resolveKey,
} from "@wolfstar/http-framework-i18n";
import {
	Command,
	RegisterAsSubcommandGroup,
} from "@wolfstar/plugin-subcommands-advanced";
import { fetchStream } from "@wolfstar/twitch-helpers";
import { MessageFlags } from "discord-api-types/v10";

const Root = LanguageKeys.Commands.Twitch;

@RegisterAsSubcommandGroup(
	SubscriptionsCommandName,
	TwitchGroupName,
	(builder) =>
		applyLocalizedBuilder(builder, Root.TestName, Root.TestDescription)
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
			Root.TestFailed,
		);
		if (subscriptionResult.isErr()) {
			return deferred.update({ content: subscriptionResult.unwrapErr() });
		}

		const guildSubscription = subscriptionResult.unwrap();
		const target = {
			guildId: BigInt(interaction.guildId!),
			channelId: BigInt(channel.id),
		};

		// The notification is sent through the very same helpers the listeners use, so a success here
		// proves the real path works. The drip is deliberately skipped: this is an explicit manual
		// action and must neither be suppressed nor consume the bucket of the real notifications.
		let deliveryResult: Result<void, NotificationDeliveryError>;
		if (subscriptionType === TwitchSubscriptionType.StreamOnline) {
			const streamData = (
				await Result.fromAsync(() => fetchStream(streamer.id))
			).unwrapOr(null);

			deliveryResult = await sendOnlineNotification({
				...target,
				message: guildSubscription.message,
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
		} else {
			// `add` enforces a message for offline subscriptions, but a row predating that check would
			// leave nothing to send.
			if (isNullishOrEmpty(guildSubscription.message)) {
				return deferred.update({
					content: await resolveKey(interaction, Root.TestMissingMessage),
				});
			}

			deliveryResult = await sendOfflineNotification({
				...target,
				message: guildSubscription.message,
				date: new Date(),
				testNotice: true,
			});
		}

		const content = cast<string>(
			await resolveKey(
				interaction,
				deliveryResult.isErr()
					? DeliveryErrorKeys[deliveryResult.unwrapErr()]
					: Root.TestSuccess,
				{ channel: channelMention(channel.id) },
			),
		);
		return deferred.update({ content });
	}
}
