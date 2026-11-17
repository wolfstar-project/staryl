import type { AddSocialSubscriptionError } from "#social/subscriptions";
import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { DefaultSocialFilters } from "#social/filters";
import { socialDelivery } from "#social/notifications";
import { addSocialSubscription } from "#social/subscriptions";
import { authorizeGuildRequest } from "#utils/guildApi/auth";
import { parseAddSubscriptionBody } from "#utils/guildApi/body";
import {
	isManageableProvider,
	readGuildApiSubscriptions,
} from "#utils/guildApi/state";
import { NotificationDeliveryError } from "#utils/notificationDelivery";
import { Result } from "@sapphire/result";
import { Route } from "@wolfstar/plugin-api";
import { ChannelType } from "discord-api-types/v10";

/** What the caller reads when the channel cannot receive the subscription. */
const ChannelErrors = {
	[NotificationDeliveryError.GuildUnavailable]: [409, "guild-unavailable"],
	[NotificationDeliveryError.ChannelNotFound]: [422, "channel-not-found"],
	[NotificationDeliveryError.MissingPermissions]: [422, "missing-permissions"],
	[NotificationDeliveryError.SendFailed]: [422, "channel-not-found"],
} as const satisfies Record<
	NotificationDeliveryError,
	readonly [number, string]
>;

/** The answers of `/subscriptions <provider> add`, as a status and a code instead of a sentence. */
const AddErrors = {
	"commands/social:addProviderNotConfigured": [422, "provider-not-configured"],
	"commands/social:addFilterUnsupported": [422, "filter-unsupported"],
	"commands/social:addLimitReached": [422, "limit-reached"],
	"commands/social:addXLimitReached": [422, "x-limit-reached"],
	"commands/social:addTargetInvalid": [422, "target-invalid"],
	"commands/social:addTargetNotFound": [422, "target-not-found"],
	"commands/social:addTargetBlocked": [422, "target-blocked"],
	"commands/social:addTargetUnsupported": [422, "target-unsupported"],
	"commands/social:addTargetUnreachable": [422, "target-unreachable"],
	"commands/social:addDuplicated": [409, "duplicate"],
	"commands/social:addFailedDatabase": [500, "database"],
} as const satisfies Record<
	AddSocialSubscriptionError,
	readonly [number, string]
>;

/**
 * `POST /guilds/:guild/subscriptions`: follows a target in a channel, as `/subscriptions
 * <provider> add` does without its filters. Answers with the new subscription and the guild's list.
 */
export class UserRoute extends Route {
	public async run(request: ApiRequest, response: ApiResponse) {
		const guild = authorizeGuildRequest(request, response);
		if (guild === null) return;

		const body = parseAddSubscriptionBody(
			await Result.fromAsync(() => request.readBodyJson()),
		);
		if (body === null) {
			response.error(400, "invalid-body");
			return;
		}
		if (!isManageableProvider(body.provider)) {
			response.error(422, "provider-not-manageable");
			return;
		}

		// The command gets a channel Discord already vetted. Here it is an id from outside, so it is
		// checked against the guild, which also proves the bot can post there before anything is saved.
		const target = await socialDelivery.prepare(guild.guildId, body.channelId);
		if (target.isErr()) {
			const [status, code] = ChannelErrors[target.unwrapErr()];
			response.error(status, code);
			return;
		}
		const { type } = target.unwrap().channel;
		if (
			type !== ChannelType.GuildText &&
			type !== ChannelType.GuildAnnouncement
		) {
			response.error(422, "channel-not-supported");
			return;
		}

		const added = await addSocialSubscription({
			guildId: guild.guildId,
			channelId: body.channelId,
			providerName: body.provider,
			input: body.target,
			message: body.message,
			filters: DefaultSocialFilters,
		});
		if (added.isErr()) {
			const [status, code] = AddErrors[added.unwrapErr()];
			response.error(status, code);
			return;
		}

		this.container.logger.info(
			`[guild-api] ${body.provider} subscription added to channel ${body.channelId} of guild ${guild.guildId} by ${guild.actor ?? "an unnamed member"}`,
		);

		const subscriptions = await Result.fromAsync(() =>
			readGuildApiSubscriptions(guild.guildId),
		);
		if (subscriptions.isErr()) {
			response.error(500, "database");
			return;
		}
		// Found by its canonical target: the same account can be typed in more than one way.
		const { target: canonical } = added.unwrap();
		const subscription = subscriptions
			.unwrap()
			.find(
				(entry) =>
					entry.channelId === String(body.channelId) &&
					entry.provider === body.provider &&
					entry.target === canonical,
			);
		response.status(201).json({
			subscription: subscription ?? null,
			subscriptions: subscriptions.unwrap(),
		});
	}
}
