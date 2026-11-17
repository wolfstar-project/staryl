import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { parseSourceId, removeSocialSubscription } from "#social/subscriptions";
import { authorizeGuildRequest, parseSnowflake } from "#utils/guildApi/auth";
import {
	isManageableProvider,
	readGuildApiSubscriptions,
	toGuildApiSubscription,
} from "#utils/guildApi/state";
import { Result } from "@sapphire/result";
import { Route } from "@wolfstar/plugin-api";

/**
 * `DELETE /guilds/:guild/subscriptions/:channel/:source`: stops a channel following a source, as
 * `/subscriptions <provider> remove` does. Answers with what was removed and what the guild has left.
 */
export class UserRoute extends Route {
	public async run(request: ApiRequest, response: ApiResponse) {
		const guild = authorizeGuildRequest(request, response);
		if (guild === null) return;

		const channelId = parseSnowflake(request.params.channel);
		const sourceId = parseSourceId(request.params.source ?? "");
		if (channelId === null || sourceId === null) {
			response.error(400, "invalid-subscription");
			return;
		}

		const key = { guildId: guild.guildId, channelId, sourceId };
		const found = await Result.fromAsync(() =>
			this.container.prisma.guildSocialSubscription.findUnique({
				where: { guildId_channelId_sourceId: key },
				include: { source: true },
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
		if (!isManageableProvider(subscription.source.provider)) {
			response.error(422, "provider-not-manageable");
			return;
		}

		const removed = await removeSocialSubscription(key);
		if (removed.isErr()) {
			this.container.logger.error(
				`[guild-api] Could not remove source ${sourceId} from channel ${channelId} of guild ${guild.guildId}`,
				removed.unwrapErr(),
			);
			response.error(500, "database");
			return;
		}

		this.container.logger.info(
			`[guild-api] ${subscription.source.provider} subscription removed from channel ${channelId} of guild ${guild.guildId} by ${guild.actor ?? "an unnamed member"}`,
		);

		const subscriptions = await Result.fromAsync(() =>
			readGuildApiSubscriptions(guild.guildId),
		);
		if (subscriptions.isErr()) {
			response.error(500, "database");
			return;
		}
		response.json({
			removed: toGuildApiSubscription(subscription),
			subscriptions: subscriptions.unwrap(),
		});
	}
}
