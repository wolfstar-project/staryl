import type { TwitchEventSubResult } from "@wolfstar/twitch-helpers";
import { Result } from "@sapphire/result";
import { isNullish } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";
import {
	addEventSubscription,
	areTwitchEventSubCredentialsSet,
	removeEventSubscription,
	TwitchEventSubTypes,
} from "@wolfstar/twitch-helpers";

/** The streamer deleted their account, so there is nothing left to subscribe to. */
const UnrecoverableStatus = "user_removed";

export type RevocationOutcome = "ignored" | "renewed" | "recorded";

/**
 * Reacts to Twitch ending an EventSub subscription, which otherwise leaves the streamer silent with
 * every command still saying it is set up.
 *
 * The usual reason is the callback failing for a while, so the subscription is simply requested
 * again. When that does not work the reason is stored, and `/subscriptions twitch show` reports it.
 */
export async function handleSubscriptionRevoked(
	revoked: Pick<TwitchEventSubResult, "id" | "status">,
): Promise<RevocationOutcome> {
	const { prisma, logger } = container;
	const subscription = await prisma.twitchSubscription.findFirst({
		where: { subscriptionId: revoked.id },
	});
	if (!subscription) return "ignored";

	if (
		revoked.status !== UnrecoverableStatus &&
		areTwitchEventSubCredentialsSet()
	) {
		const renewal = await Result.fromAsync(() =>
			addEventSubscription(
				subscription.streamerId,
				TwitchEventSubTypes[subscription.subscriptionType],
			),
		);
		const renewedId = renewal.isOk() ? renewal.unwrap()?.id : null;
		if (!isNullish(renewedId)) {
			const stored = await Result.fromAsync(() =>
				markRevocation(revoked.id, {
					subscriptionId: renewedId,
					revokedReason: null,
				}),
			);
			if (stored.isOk()) return "renewed";

			logger.error(
				`[twitch-subscriptions] Could not store the renewed subscription of ${subscription.streamerId}`,
				stored.unwrapErr(),
			);
			// Left alive it would be an orphan nothing points at, and Twitch answers 409 to the next
			// attempt. If this fails too there is nothing more to do from here.
			await Result.fromAsync(() => removeEventSubscription(renewedId));
		} else {
			logger.error(
				`[twitch-subscriptions] Could not renew the revoked subscription of ${subscription.streamerId}`,
				renewal.isErr() ? renewal.unwrapErr() : undefined,
			);
		}
	}

	await markRevocation(revoked.id, { revokedReason: revoked.status });
	return "recorded";
}

/**
 * Keyed on the EventSub id rather than the row: a duplicate of the message can arrive while the
 * first one is being handled, and must not mark the subscription that was just renewed.
 */
function markRevocation(
	subscriptionId: string,
	data: { subscriptionId?: string; revokedReason: string | null },
) {
	return container.prisma.twitchSubscription.updateMany({
		where: { subscriptionId },
		data,
	});
}
