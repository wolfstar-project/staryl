import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { TwitchSubscriptionType } from "#generated/prisma";
import { parseSourceId } from "#social/subscriptions";
import { fetchStreamerNames } from "#twitch/subscriptions";
import { authorizeGuildRequest, parseSnowflake } from "#utils/guildApi/auth";
import { parseEditSubscriptionBody } from "#utils/guildApi/body";
import {
	assertEditChannel,
	EditWriteErrors,
	toEditData,
	toEditWriteError,
} from "#utils/guildApi/edit";
import { readTwitchSubscriptions } from "#utils/guildApi/state";
import { Result } from "@sapphire/result";
import { Route } from "@wolfstar/plugin-api";

/**
 * `PATCH /guilds/:guild/twitch/:channel/:subscription`: moves a Twitch live notification to another
 * channel or changes its message. The streamer and the event stay. An end-of-stream notification
 * keeps a message, as `/subscriptions twitch add` asks for one. Answers with the notification
 * before and after the edit, and the guild's Twitch live list.
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

		const edit = parseEditSubscriptionBody(
			await Result.fromAsync(() => request.readBodyJson()),
		);
		if (edit === null) {
			response.error(400, "invalid-body");
			return;
		}

		const key = { guildId: guild.guildId, channelId, subscriptionId };
		const found = await Result.fromAsync(() =>
			this.container.prisma.guildSubscription.findUnique({
				where: { guildId_channelId_subscriptionId: key },
				include: { twitchSubscription: true },
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
		if (
			edit.message === null &&
			previous.twitchSubscription.subscriptionType ===
				TwitchSubscriptionType.StreamOffline
		) {
			response.error(422, "message-required");
			return;
		}
		if (!(await assertEditChannel(response, guild.guildId, channelId, edit)))
			return;

		const saved = await Result.fromAsync(() =>
			this.container.prisma.guildSubscription.update({
				where: { guildId_channelId_subscriptionId: key },
				data: toEditData(channelId, edit),
			}),
		);
		if (saved.isErr()) {
			const known = toEditWriteError(saved.unwrapErr());
			if (known === null) {
				this.container.logger.error(
					`[guild-api] Could not edit Twitch subscription ${subscriptionId} in channel ${channelId} of guild ${guild.guildId}`,
					saved.unwrapErr(),
				);
				response.error(500, "database");
				return;
			}
			response.error(EditWriteErrors[known], known);
			return;
		}

		this.container.logger.info(
			`[guild-api] Twitch subscription ${subscriptionId} edited in channel ${channelId} of guild ${guild.guildId} by ${guild.actor ?? "an unnamed member"}`,
		);

		const { streamerId, subscriptionType, revokedReason } =
			previous.twitchSubscription;
		const names = await fetchStreamerNames([streamerId]);
		const describe = (row: { channelId: bigint; message: string | null }) => ({
			subscriptionId: String(subscriptionId),
			streamerId,
			streamerName: names.get(streamerId) ?? null,
			channelId: String(row.channelId),
			type: subscriptionType,
			message: row.message,
			revoked: revokedReason !== null,
		});
		const twitch = (
			await Result.fromAsync(() => readTwitchSubscriptions(guild.guildId))
		)
			.inspectErr((error) =>
				this.container.logger.error(
					`[guild-api] Edited a Twitch subscription in guild ${guild.guildId}, but could not list them`,
					error,
				),
			)
			.unwrapOr(null);

		response.json({
			previous: describe(previous),
			subscription: describe(saved.unwrap()),
			twitch,
		});
	}
}
