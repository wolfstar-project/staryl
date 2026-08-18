// oxlint-disable no-await-in-loop -- sequential per-guild processing is intentional
import type { TwitchEventSubEvent } from "@wolfstar/twitch-helpers";
import { streamNotificationDrip } from "#utils/twitch";
import { sendOfflineNotification } from "#utils/twitchNotifications";
import { isNullishOrEmpty } from "@sapphire/utilities";
import { Listener } from "@wolfstar/http-framework";
import { TwitchEventSubTypes } from "@wolfstar/twitch-helpers";

export default class extends Listener {
	public async run(data: TwitchEventSubEvent) {
		const date = new Date();
		this.container.logger.debug(
			`[twitch-stream-offline] Received event for ${data.broadcaster_user_login} (${data.broadcaster_user_id})`,
		);

		const twitchSubscription =
			await this.container.prisma.twitchSubscription.findFirst({
				where: {
					streamerId: data.broadcaster_user_id,
					subscriptionType: "StreamOffline",
				},
				include: { guildSubscription: true },
			});

		if (!twitchSubscription) {
			this.container.logger.debug(
				`[twitch-stream-offline] No subscription stored for streamer ${data.broadcaster_user_id}, ignoring the event`,
			);
			return;
		}

		this.container.logger.debug(
			`[twitch-stream-offline] Streamer ${data.broadcaster_user_id} has ${twitchSubscription.guildSubscription.length} guild subscription(s)`,
		);

		// Iterate over all the guilds that are subscribed to this streamer and subscription type
		for (const guildSubscription of twitchSubscription.guildSubscription) {
			// The offline notification is the custom message; without one there is nothing to send.
			if (isNullishOrEmpty(guildSubscription.message)) {
				this.container.logger.debug(
					`[twitch-stream-offline] Channel ${guildSubscription.channelId} of guild ${guildSubscription.guildId} has no message, skipping`,
				);
				continue;
			}

			if (
				streamNotificationDrip(
					`${twitchSubscription.streamerId}-${guildSubscription.channelId}-${TwitchEventSubTypes.StreamOffline}`,
				)
			) {
				this.container.logger.debug(
					`[twitch-stream-offline] Drip skipped channel ${guildSubscription.channelId} of guild ${guildSubscription.guildId} for streamer ${twitchSubscription.streamerId}`,
				);
				continue;
			}

			this.container.logger.debug(
				`[twitch-stream-offline] Notifying channel ${guildSubscription.channelId} of guild ${guildSubscription.guildId} for streamer ${twitchSubscription.streamerId}`,
			);

			const result = await sendOfflineNotification({
				guildId: guildSubscription.guildId,
				channelId: guildSubscription.channelId,
				message: guildSubscription.message,
				date,
			});

			if (result.isErr()) {
				this.container.logger.error(
					`[twitch-stream-offline] Could not notify channel ${guildSubscription.channelId} of guild ${guildSubscription.guildId} for streamer ${twitchSubscription.streamerId} (reason ${result.unwrapErr()})`,
				);
			} else {
				this.container.logger.debug(
					`[twitch-stream-offline] Notified channel ${guildSubscription.channelId} of guild ${guildSubscription.guildId} for streamer ${twitchSubscription.streamerId}`,
				);
			}
		}
	}
}
