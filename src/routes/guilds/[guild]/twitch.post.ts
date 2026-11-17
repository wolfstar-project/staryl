import type { AddSubscriptionErrorKey } from "#twitch/subscriptions";
import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { addSubscription } from "#twitch/subscriptions";
import { authorizeGuildRequest } from "#utils/guildApi/auth";
import { parseAddTwitchBody } from "#utils/guildApi/body";
import { assertNotificationChannel } from "#utils/guildApi/channel";
import {
	isTwitchLiveConfigured,
	readTwitchSubscriptions,
} from "#utils/guildApi/state";
import { Result } from "@sapphire/result";
import { Route } from "@wolfstar/plugin-api";

/** The answers of `/subscriptions twitch add`, as a status and a code instead of a sentence. */
const AddErrors = {
	"commands/twitch:addMessageForOfflineRequired": [422, "message-required"],
	"commands/twitch:streamerNotFound": [422, "streamer-not-found"],
	"commands/twitch:addDuplicated": [409, "duplicate"],
	// Twitch refused, or the bot has no EventSub credentials. A 4xx, so the caller tells it apart
	// from Staryl being down.
	"commands/twitch:addFailedTwitch": [422, "twitch-failed"],
	"commands/twitch:addFailedDatabase": [500, "database"],
} as const satisfies Record<AddSubscriptionErrorKey, readonly [number, string]>;

/**
 * `POST /guilds/:guild/twitch`: notifies a channel when a streamer goes live or offline, as
 * `/subscriptions twitch add` does. An offline notification needs a message. Answers with the new
 * subscription and the guild's Twitch live list.
 */
export class UserRoute extends Route {
	public async run(request: ApiRequest, response: ApiResponse) {
		const guild = authorizeGuildRequest(request, response);
		if (guild === null) return;

		const body = parseAddTwitchBody(
			await Result.fromAsync(() => request.readBodyJson()),
		);
		if (body === null) {
			response.error(400, "invalid-body");
			return;
		}
		if (!isTwitchLiveConfigured()) {
			response.error(422, "provider-not-configured");
			return;
		}
		if (
			!(await assertNotificationChannel(
				response,
				guild.guildId,
				body.channelId,
			))
		)
			return;

		const added = await addSubscription(
			guild.guildId,
			body.channelId,
			body.streamer,
			body.type,
			body.message,
		);
		if (added.isErr()) {
			const [status, code] = AddErrors[added.unwrapErr()];
			response.error(status, code);
			return;
		}

		const { streamer } = added.unwrap();
		this.container.logger.info(
			`[guild-api] Twitch ${body.type} subscription to ${streamer.id} added to channel ${body.channelId} of guild ${guild.guildId} by ${guild.actor ?? "an unnamed member"}`,
		);

		// The subscription is saved by now. A list that cannot be read must not turn that into a
		// failure: the caller would try again and be told the subscription is a duplicate.
		const twitch = (
			await Result.fromAsync(() => readTwitchSubscriptions(guild.guildId))
		)
			.inspectErr((error) =>
				this.container.logger.error(
					`[guild-api] Added a Twitch subscription in guild ${guild.guildId}, but could not list them`,
					error,
				),
			)
			.unwrapOr(null);

		const subscription = twitch?.find(
			(entry) =>
				entry.channelId === String(body.channelId) &&
				entry.streamerId === streamer.id &&
				entry.type === body.type,
		);
		response.status(201).json({ subscription: subscription ?? null, twitch });
	}
}
