import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { parseSourceId } from "#social/subscriptions";
import {
	deleteSubscription,
	fetchStreamerNames,
	removeSubscription,
} from "#twitch/subscriptions";
import { authorizeGuildRequest, parseSnowflake } from "#utils/guildApi/auth";
import { readTwitchSubscriptions } from "#utils/guildApi/state";
import { Result } from "@sapphire/result";
import { Route } from "@wolfstar/plugin-api";

/**
 * `DELETE /guilds/:guild/twitch/:channel/:subscription`: stops a channel's Twitch live
 * notification, as `/subscriptions twitch remove` does. `:subscription` is the `subscriptionId`
 * the list gives. The shared subscription, and its EventSub subscription on Twitch, go once no
 * channel uses them. Answers with what was removed and the guild's Twitch live list.
 */
export class UserRoute extends Route {
	public async run(request: ApiRequest, response: ApiResponse) {
		const guild = authorizeGuildRequest(request, response);
		if (guild === null) return;

		const channelId = parseSnowflake(request.params.channel);
		const subscriptionId = parseSourceId(request.params.subscription ?? "");
		if (channelId === null || subscriptionId === null) {
			response.error(400, "invalid-subscription");
			return;
		}

		const found = await Result.fromAsync(() =>
			this.container.prisma.guildSubscription.findUnique({
				where: {
					guildId_channelId_subscriptionId: {
						guildId: guild.guildId,
						channelId,
						subscriptionId,
					},
				},
				include: { twitchSubscription: true },
			}),
		);
		if (found.isErr()) {
			response.error(500, "database");
			return;
		}

		const subscription = found.unwrap();
		if (subscription === null) {
			response.error(404, "subscription-not-found");
			return;
		}

		// Two steps, as the command takes them: the channel's row, then the shared one if it is
		// left unused. The second can fail on Twitch without undoing the first, which is the
		// removal the member asked for.
		const removed = await Result.fromAsync(() =>
			deleteSubscription(subscription),
		);
		if (removed.isErr()) {
			this.container.logger.error(
				`[guild-api] Could not remove Twitch subscription ${subscriptionId} from channel ${channelId} of guild ${guild.guildId}`,
				removed.unwrapErr(),
			);
			response.error(500, "database");
			return;
		}
		(
			await Result.fromAsync(() => removeSubscription(subscriptionId))
		).inspectErr((error) =>
			this.container.logger.error(
				`[guild-api] Removed a Twitch subscription in guild ${guild.guildId}, but could not clean up shared subscription ${subscriptionId}`,
				error,
			),
		);

		this.container.logger.info(
			`[guild-api] Twitch subscription ${subscriptionId} removed from channel ${channelId} of guild ${guild.guildId} by ${guild.actor ?? "an unnamed member"}`,
		);

		const { streamerId, subscriptionType, revokedReason } =
			subscription.twitchSubscription;
		const names = await fetchStreamerNames([streamerId]);
		const twitch = (
			await Result.fromAsync(() => readTwitchSubscriptions(guild.guildId))
		)
			.inspectErr((error) =>
				this.container.logger.error(
					`[guild-api] Removed a Twitch subscription in guild ${guild.guildId}, but could not list them`,
					error,
				),
			)
			.unwrapOr(null);

		response.json({
			removed: {
				subscriptionId: String(subscriptionId),
				streamerId,
				streamerName: names.get(streamerId) ?? null,
				channelId: String(channelId),
				type: subscriptionType,
				message: subscription.message,
				revoked: revokedReason !== null,
			},
			twitch,
		});
	}
}
