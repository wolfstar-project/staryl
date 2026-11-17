import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { parseSourceId } from "#social/subscriptions";
import { authorizeGuildRequest, parseSnowflake } from "#utils/guildApi/auth";
import { parseEditSubscriptionBody } from "#utils/guildApi/body";
import {
	assertEditChannel,
	editMovesChannel,
	EditWriteErrors,
	toEditData,
	toEditWriteError,
} from "#utils/guildApi/edit";
import {
	isManageableProvider,
	readGuildApiSubscriptions,
	toGuildApiSubscription,
} from "#utils/guildApi/state";
import { Result } from "@sapphire/result";
import { Route } from "@wolfstar/plugin-api";

/**
 * `PATCH /guilds/:guild/subscriptions/:channel/:source`: moves a subscription to another channel
 * or changes its message. The account and the filters stay. Answers with the subscription before
 * and after the edit, and the guild's list.
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

		const edit = parseEditSubscriptionBody(
			await Result.fromAsync(() => request.readBodyJson()),
		);
		if (edit === null) {
			response.error(400, "invalid-body");
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

		const previous = found.unwrap();
		if (previous === null) {
			response.error(404, "subscription-not-found");
			return;
		}
		if (!isManageableProvider(previous.source.provider)) {
			response.error(422, "provider-not-manageable");
			return;
		}
		if (!(await assertEditChannel(response, guild.guildId, channelId, edit)))
			return;

		const saved = await Result.fromAsync(() =>
			this.container.prisma.guildSocialSubscription.update({
				where: { guildId_channelId_sourceId: key },
				data: {
					...toEditData(channelId, edit),
					// The last delivery error was the old channel's. Twitch live keeps none.
					...(editMovesChannel(channelId, edit) ? { deliveryError: null } : {}),
				},
				include: { source: true },
			}),
		);
		if (saved.isErr()) {
			const known = toEditWriteError(saved.unwrapErr());
			if (known === null) {
				this.container.logger.error(
					`[guild-api] Could not edit source ${sourceId} in channel ${channelId} of guild ${guild.guildId}`,
					saved.unwrapErr(),
				);
				response.error(500, "database");
				return;
			}
			response.error(EditWriteErrors[known], known);
			return;
		}

		this.container.logger.info(
			`[guild-api] ${previous.source.provider} subscription edited in channel ${channelId} of guild ${guild.guildId} by ${guild.actor ?? "an unnamed member"}`,
		);

		// The edit is saved by now. A list that cannot be read must not turn that into a failure.
		const subscriptions = (
			await Result.fromAsync(() => readGuildApiSubscriptions(guild.guildId))
		)
			.inspectErr((error) =>
				this.container.logger.error(
					`[guild-api] Edited a subscription in guild ${guild.guildId}, but could not list them`,
					error,
				),
			)
			.unwrapOr(null);
		response.json({
			previous: toGuildApiSubscription(previous),
			subscription: toGuildApiSubscription(saved.unwrap()),
			subscriptions,
		});
	}
}
