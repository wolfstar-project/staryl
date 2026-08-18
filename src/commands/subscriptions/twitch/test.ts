import type { TwitchSubscriptionOptions } from "#utils/twitchSubscriptions";
import { TwitchSubscriptionType } from "#generated/prisma";
import { LanguageKeys } from "#i18n";
import {
	NotificationDeliveryError,
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
import { container } from "@wolfstar/http-framework";
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
		container.logger.debug(
			`[twitch-test] Invoked in guild ${interaction.guildId} for streamer "${options.streamer}", channel ${options.channel.id}, type ${options.type}`,
		);

		const streamer = await getStreamer(options.streamer);
		if (isNullish(streamer)) {
			container.logger.debug(
				`[twitch-test] Aborted: the streamer "${options.streamer}" was not found`,
			);
			return deferred.update({
				content: await resolveKey(interaction, Root.StreamerNotFound),
			});
		}

		const { channel, type: subscriptionType } = options;
		container.logger.debug(
			`[twitch-test] Resolved streamer ${streamer.login} (${streamer.id})`,
		);

		const subscriptionResult = await resolveSubscription(
			interaction,
			streamer,
			channel,
			subscriptionType,
			Root.TestFailed,
		);
		if (subscriptionResult.isErr()) {
			container.logger.debug(
				`[twitch-test] Aborted: no ${subscriptionType} subscription for streamer ${streamer.id} in channel ${channel.id}`,
			);
			return deferred.update({ content: subscriptionResult.unwrapErr() });
		}

		const guildSubscription = subscriptionResult.unwrap();
		container.logger.debug(
			`[twitch-test] Resolved guild subscription ${guildSubscription.id}, message ${guildSubscription.message === null ? "unset" : `of ${guildSubscription.message.length} characters`}`,
		);
		const target = {
			guildId: BigInt(interaction.guildId!),
			channelId: BigInt(channel.id),
		};

		// The notification is sent through the very same helpers the listeners use, so a success here
		// proves the real path works. The drip is deliberately skipped: this is an explicit manual
		// action and must neither be suppressed nor consume the bucket of the real notifications.
		let deliveryResult: Result<void, NotificationDeliveryError>;
		if (subscriptionType === TwitchSubscriptionType.StreamOnline) {
			const streamResult = await Result.fromAsync(() =>
				fetchStream(streamer.id),
			);
			if (streamResult.isErr()) {
				container.logger.debug(
					`[twitch-test] Could not fetch the stream of ${streamer.id}`,
					streamResult.unwrapErr(),
				);
			}

			const streamData = streamResult.unwrapOr(null);
			container.logger.debug(
				`[twitch-test] Stream data for ${streamer.id}: ${JSON.stringify(streamData)}`,
			);

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
				container.logger.debug(
					`[twitch-test] Aborted: the offline subscription ${guildSubscription.id} has no message`,
				);
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

		container.logger.debug(
			`[twitch-test] Delivery to channel ${channel.id}: ${
				deliveryResult.isErr()
					? `failed with ${NotificationDeliveryError[deliveryResult.unwrapErr()]}`
					: "succeeded"
			}`,
		);

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
