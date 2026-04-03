// oxlint-disable unused-imports/no-unused-vars
import { RateLimitManager } from "@sapphire/ratelimits";
import { Result } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";

const manager = new RateLimitManager(Time.Minute * 3000, 1);

export function streamNotificationDrip(id: string) {
  return Result.from(() => manager.acquire(id).consume()).isOk();
}

// oxlint-disable-next-line no-restricted-syntax
export const enum TwitchStreamStatus {
  Online = "online",
  Offline = "offline",
}
