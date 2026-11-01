import type { ProviderFailure } from "#social/provider";
import {
	describeSourceHealth,
	FailingThreshold,
	MaximumBackoff,
	MaximumTargetUnavailableBackoff,
	planNextCheck,
	TargetUnavailableBackoff,
} from "#social/schedule";
import { Time } from "@sapphire/time-utilities";
import { describe, expect, it } from "vitest";

const Now = Date.UTC(2026, 10, 1);
const IntervalMs = Time.Minute * 10;

function plan(failure: ProviderFailure | null, failureCount = 0, random = 0) {
	const result = planNextCheck({
		intervalMs: IntervalMs,
		failure,
		failureCount,
		now: Now,
		random,
	});
	return { ...result, delay: result.nextCheckAt.getTime() - Now };
}

describe("planNextCheck", () => {
	it("returns to the regular interval and forgets the failures after a success", () => {
		expect(plan(null, 7)).toMatchObject({
			delay: IntervalMs,
			failureCount: 0,
			lastFailure: null,
		});
	});

	it("spreads healthy sources by at most a tenth of the interval", () => {
		expect(plan(null, 0, 1).delay).toBe(IntervalMs * 1.1);
	});

	it.each([
		[0, IntervalMs * 2],
		[1, IntervalMs * 4],
		[2, IntervalMs * 8],
	])("doubles the wait after %i earlier failures", (failureCount, delay) => {
		expect(plan({ _tag: "Unavailable" }, failureCount)).toMatchObject({
			delay,
			failureCount: failureCount + 1,
			lastFailure: "Unavailable",
		});
	});

	it("caps the wait of a source that keeps failing", () => {
		expect(plan({ _tag: "Unavailable" }, 30).delay).toBe(MaximumBackoff);
	});

	it("honours the wait a rate limit asks for", () => {
		const failure = { _tag: "RateLimited", retryAfterMs: Time.Hour } as const;
		expect(plan(failure).delay).toBe(Time.Hour);
	});

	it("does not let a server park a source indefinitely", () => {
		const failure = {
			_tag: "RateLimited",
			retryAfterMs: Time.Day * 365,
		} as const;
		expect(plan(failure).delay).toBe(MaximumBackoff);
	});

	it("never checks sooner than the interval, even if the limit allows it", () => {
		const failure = { _tag: "RateLimited", retryAfterMs: 1 } as const;
		expect(plan(failure).delay).toBe(IntervalMs);
	});

	it("waits longer for a target that is gone, up to a day", () => {
		expect(plan({ _tag: "TargetUnavailable" }).delay).toBe(
			TargetUnavailableBackoff,
		);
		expect(plan({ _tag: "TargetUnavailable" }, 30).delay).toBe(
			MaximumTargetUnavailableBackoff,
		);
	});
});

describe("describeSourceHealth", () => {
	it.each([
		[null, 0, "active"],
		["RateLimited", 1, "rateLimited"],
		["TargetUnavailable", 1, "targetUnavailable"],
		["AuthFailed", 1, "authFailed"],
		["Unavailable", FailingThreshold - 1, "active"],
		["Unavailable", FailingThreshold, "failing"],
		["InvalidResponse", FailingThreshold, "failing"],
	] as const)(
		"reads %s after %i failures as %s",
		(lastFailure, failureCount, health) => {
			expect(describeSourceHealth({ lastFailure, failureCount })).toBe(health);
		},
	);
});
