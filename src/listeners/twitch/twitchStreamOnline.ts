// oxlint-disable no-await-in-loop -- sequential per-guild processing is intentional
import type { TwitchEventSubOnlineEvent } from "@wolfstar/twitch-helpers";
import { streamNotificationDrip } from "#utils/twitch";
import { sendOnlineNotification } from "#utils/twitchNotifications";
import { Listener } from "@wolfstar/http-framework";
import { fetchStream, TwitchEventSubTypes } from "@wolfstar/twitch-helpers";

export default class extends Listener {
	public async run(data: TwitchEventSubOnlineEvent) {
		const twitchSubscription =
			await this.container.prisma.twitchSubscription.findFirst({
				where: {
					streamerId: data.broadcaster_user_id,
					subscriptionType: "StreamOnline",
				},
				include: { guildSubscription: true },
			});

		if (twitchSubscription) {
			const streamData = await fetchStream(data.broadcaster_user_id);

			// Iterate over all the guilds that are subscribed to this streamer and subscription type
			for (const guildSubscription of twitchSubscription.guildSubscription) {
				if (
					streamNotificationDrip(
						`${twitchSubscription.streamerId}-${guildSubscription.channelId}-${TwitchEventSubTypes.StreamOnline}`,
					)
				) {
					continue;
				}

				const result = await sendOnlineNotification({
					guildId: guildSubscription.guildId,
					channelId: guildSubscription.channelId,
					message: guildSubscription.message,
					event: data,
					streamData,
				});

				if (result.isErr()) {
					this.container.logger.error(
						`[twitch-stream-online] Could not notify channel ${guildSubscription.channelId} of guild ${guildSubscription.guildId} for streamer ${twitchSubscription.streamerId} (reason ${result.unwrapErr()})`,
					);
				}
			}
		}
	}
}
