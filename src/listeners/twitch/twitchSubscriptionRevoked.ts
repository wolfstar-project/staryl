import type { TwitchEventSubResult } from "@wolfstar/twitch-helpers";
import { handleSubscriptionRevoked } from "#twitch/revocations";
import { Listener } from "@wolfstar/http-framework";

export default class extends Listener {
	public async run(subscription: TwitchEventSubResult) {
		const outcome = await handleSubscriptionRevoked(subscription);
		this.container.logger.warn(
			`[twitch-subscription-revoked] Twitch revoked "${subscription.id}" (${subscription.status}): ${outcome}`,
		);
	}
}
