import { RateLimitManager } from "@sapphire/ratelimits";
import { Result } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";

/**
 * Twitch re-delivers EventSub notifications it believes were not acknowledged, so the same
 * `stream.online` can arrive several times within a few minutes. One notification per bucket over a
 * short window is enough to collapse those duplicates without suppressing a genuine second stream.
 */
const manager = new RateLimitManager(Time.Minute * 3, 1);

/**
 * Whether the notification identified by {@link id} must be dropped as a duplicate.
 *
 * `RateLimit#consume()` throws *only* when the bucket is already limited, so `isErr()` is the
 * "rate limited" branch — which is what the callers use to skip the notification.
 */
export function streamNotificationDrip(id: string) {
	return Result.from(() => manager.acquire(id).consume()).isErr();
}
