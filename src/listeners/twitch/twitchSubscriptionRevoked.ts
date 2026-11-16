import type { TwitchEventSubResult } from "@wolfstar/twitch-helpers";
import { handleSubscriptionRevoked } from "#twitch/revocations";
import { Events } from "#types";
import { ApplyOptions } from "@wolfstar/decorators";
import { Listener } from "@wolfstar/http-framework";

@ApplyOptions<Listener.Options>({
	emitter: "client",
	event: Events.TwitchSubscriptionRevoked,
})
export class UserListener extends Listener {
	public async run(subscription: TwitchEventSubResult) {
		const outcome = await handleSubscriptionRevoked(subscription);
		this.container.logger.warn(
			`[twitch-subscription-revoked] Twitch revoked "${subscription.id}" (${subscription.status}): ${outcome}`,
		);
	}
}
