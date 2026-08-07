import { streamNotificationDrip } from "#utils/twitch";
import { describe, expect, it } from "vitest";

describe("streamNotificationDrip", () => {
	it("lets the first notification of a bucket through", () => {
		// Regression: the predicate used to be `isOk()`, which is true precisely when the bucket is
		// NOT limited. Both listeners `continue` on a truthy result, so the very notification that
		// should have been delivered was the one being dropped.
		expect(streamNotificationDrip("first-bucket")).toBe(false);
	});

	it("drops a repeat of the same bucket within the window", () => {
		expect(streamNotificationDrip("repeated-bucket")).toBe(false);
		expect(streamNotificationDrip("repeated-bucket")).toBe(true);
		expect(streamNotificationDrip("repeated-bucket")).toBe(true);
	});

	it("keeps buckets independent", () => {
		expect(streamNotificationDrip("streamer-a")).toBe(false);
		expect(streamNotificationDrip("streamer-b")).toBe(false);
		expect(streamNotificationDrip("streamer-a")).toBe(true);
		expect(streamNotificationDrip("streamer-b")).toBe(true);
	});
});
