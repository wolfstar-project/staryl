import { parseRetryAfter, toHttpFailure } from "#social/http";
import { Time } from "@sapphire/time-utilities";
import { describe, expect, it } from "vitest";

const Now = Date.UTC(2026, 10, 1);

describe("parseRetryAfter", () => {
	it.each([
		["120", 120_000],
		[" 5 ", 5000],
		[new Date(Now + Time.Minute).toUTCString(), Time.Minute],
		[new Date(Now - Time.Minute).toUTCString(), 0],
	])("reads %j", (value, expected) => {
		expect(parseRetryAfter(value, Now)).toBe(expected);
	});

	it.each([null, undefined, "", "soon"])("answers nothing for %j", (value) => {
		expect(parseRetryAfter(value, Now)).toBeNull();
	});

	it.each(["31536000", "9".repeat(400)])(
		"does not let %s park a source indefinitely",
		(value) => {
			expect(parseRetryAfter(value, Now)).toBe(Time.Hour * 6);
		},
	);
});

describe("toHttpFailure", () => {
	it.each([
		[401, "AuthFailed"],
		[403, "AuthFailed"],
		[404, "TargetUnavailable"],
		[410, "TargetUnavailable"],
		[451, "TargetUnavailable"],
		[500, "Unavailable"],
		[503, "Unavailable"],
	])("reads %i as %s", (status, tag) => {
		expect(toHttpFailure(status)._tag).toBe(tag);
	});

	it.each([429, 503])("reads %i with a wait as a rate limit", (status) => {
		expect(toHttpFailure(status, "10")).toEqual({
			_tag: "RateLimited",
			retryAfterMs: 10_000,
		});
	});
});
