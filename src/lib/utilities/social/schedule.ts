import type { SocialFailure } from "#lib/setup/prisma";
import type { ProviderFailure } from "#social/provider";
import { Time } from "@sapphire/time-utilities";

export type SourceHealth =
	| "active"
	| "failing"
	| "rateLimited"
	| "targetUnavailable"
	| "authFailed";

export interface CheckPlan {
	nextCheckAt: Date;
	failureCount: number;
	lastFailure: SocialFailure | null;
}

/** The longest a source that keeps failing waits between checks. */
export const MaximumBackoff = Time.Hour * 6;
/** A gone account rarely returns soon, but it can: a suspension may be lifted, a feed restored. */
export const TargetUnavailableBackoff = Time.Hour;
export const MaximumTargetUnavailableBackoff = Time.Day;
/** One timeout should not read as an outage, so short blips stay out of `/subscriptions show`. */
export const FailingThreshold = 3;

/** The share of the interval added at random so sources added together do not stay in lockstep. */
const JitterRatio = 0.1;

export function planNextCheck(options: {
	intervalMs: number;
	failure: ProviderFailure | null;
	failureCount: number;
	now: number;
	random: number;
}): CheckPlan {
	const { intervalMs, failure, now, random } = options;
	if (failure === null) {
		return {
			nextCheckAt: new Date(now + intervalMs * (1 + JitterRatio * random)),
			failureCount: 0,
			lastFailure: null,
		};
	}

	const failureCount = options.failureCount + 1;
	return {
		nextCheckAt: new Date(now + getBackoff(failure, intervalMs, failureCount)),
		failureCount,
		lastFailure: failure._tag,
	};
}

export function describeSourceHealth(source: {
	lastFailure: SocialFailure | null;
	failureCount: number;
}): SourceHealth {
	switch (source.lastFailure) {
		case null:
			return "active";
		case "RateLimited":
			return "rateLimited";
		case "TargetUnavailable":
			return "targetUnavailable";
		case "AuthFailed":
			return "authFailed";
		default:
			return source.failureCount >= FailingThreshold ? "failing" : "active";
	}
}

function getBackoff(
	failure: ProviderFailure,
	intervalMs: number,
	failureCount: number,
) {
	const doublings = 2 ** (failureCount - 1);
	switch (failure._tag) {
		case "RateLimited":
			return Math.min(
				Math.max(failure.retryAfterMs ?? intervalMs * 2, intervalMs),
				MaximumBackoff,
			);
		case "TargetUnavailable":
			return Math.min(
				TargetUnavailableBackoff * doublings,
				MaximumTargetUnavailableBackoff,
			);
		default:
			return Math.min(intervalMs * 2 * doublings, MaximumBackoff);
	}
}
