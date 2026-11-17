import type { AddSocialSubscriptionError } from "#social/subscriptions";
import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { DefaultSocialFilters } from "#social/filters";
import { addSocialSubscription } from "#social/subscriptions";
import { authorizeGuildRequest } from "#utils/guildApi/auth";
import { parseAddSubscriptionBody } from "#utils/guildApi/body";
import { assertNotificationChannel } from "#utils/guildApi/channel";
import {
	isManageableProvider,
	readGuildApiSubscriptions,
} from "#utils/guildApi/state";
import { Result } from "@sapphire/result";
import { Route } from "@wolfstar/plugin-api";

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

		if (
			!(await assertNotificationChannel(
				response,
				guild.guildId,
				body.channelId,
			))
		)
			return;

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

		// The subscription is saved by now. A list that cannot be read must not turn that into a
		// failure: the caller would try again and be told the subscription is a duplicate.
		const subscriptions = (
			await Result.fromAsync(() => readGuildApiSubscriptions(guild.guildId))
		)
			.inspectErr((error) =>
				this.container.logger.error(
					`[guild-api] Added a subscription in guild ${guild.guildId}, but could not list them`,
					error,
				),
			)
			.unwrapOr(null);

		// Found by its canonical target: the same account can be typed in more than one way.
		const { target: canonical } = added.unwrap();
		const subscription = subscriptions?.find(
			(entry) =>
				entry.channelId === String(body.channelId) &&
				entry.provider === body.provider &&
				entry.target === canonical,
		);
		response.status(201).json({
			subscription: subscription ?? null,
			subscriptions,
		});
	}
}
