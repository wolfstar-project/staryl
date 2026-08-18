// oxlint-disable no-await-in-loop -- sequential per-guild processing is intentional
import type { TwitchEventSubOnlineEvent } from "@wolfstar/twitch-helpers";
import { streamNotificationDrip } from "#utils/twitch";
import { sendOnlineNotification } from "#utils/twitchNotifications";
import { Listener } from "@wolfstar/http-framework";
import { fetchStream, TwitchEventSubTypes } from "@wolfstar/twitch-helpers";

export default class extends Listener {
	public async run(data: TwitchEventSubOnlineEvent) {
		this.container.logger.debug(
			`[twitch-stream-online] Received event for ${data.broadcaster_user_login} (${data.broadcaster_user_id}), started at ${data.started_at}`,
		);

		const twitchSubscription =
			await this.container.prisma.twitchSubscription.findFirst({
				where: {
					streamerId: data.broadcaster_user_id,
					subscriptionType: "StreamOnline",
				},
				include: { guildSubscription: true },
			});

		if (!twitchSubscription) {
			this.container.logger.debug(
				`[twitch-stream-online] No subscription stored for streamer ${data.broadcaster_user_id}, ignoring the event`,
			);
			return;
		}

		const streamData = await fetchStream(data.broadcaster_user_id);
		this.container.logger.debug(
			`[twitch-stream-online] Streamer ${data.broadcaster_user_id} has ${twitchSubscription.guildSubscription.length} guild subscription(s), stream data: ${JSON.stringify(streamData)}`,
		);

		// Iterate over all the guilds that are subscribed to this streamer and subscription type
		for (const guildSubscription of twitchSubscription.guildSubscription) {
			if (
				streamNotificationDrip(
					`${twitchSubscription.streamerId}-${guildSubscription.channelId}-${TwitchEventSubTypes.StreamOnline}`,
				)
			) {
				this.container.logger.debug(
					`[twitch-stream-online] Drip skipped channel ${guildSubscription.channelId} of guild ${guildSubscription.guildId} for streamer ${twitchSubscription.streamerId}`,
				);
				continue;
			}

			this.container.logger.debug(
				`[twitch-stream-online] Notifying channel ${guildSubscription.channelId} of guild ${guildSubscription.guildId} for streamer ${twitchSubscription.streamerId}`,
			);

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
			} else {
				this.container.logger.debug(
					`[twitch-stream-online] Notified channel ${guildSubscription.channelId} of guild ${guildSubscription.guildId} for streamer ${twitchSubscription.streamerId}`,
				);
			}
		}
	}
}
