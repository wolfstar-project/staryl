import { handleSubscriptionRevoked } from "#twitch/revocations";
import { container } from "@wolfstar/http-framework";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@wolfstar/twitch-helpers", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@wolfstar/twitch-helpers")>();
	return {
		...actual,
		addEventSubscription: vi.fn(),
		areTwitchEventSubCredentialsSet: vi.fn(),
		removeEventSubscription: vi.fn(),
	};
});

const {
	addEventSubscription,
	areTwitchEventSubCredentialsSet,
	removeEventSubscription,
} = await import("@wolfstar/twitch-helpers");

const prismaMock = {
	twitchSubscription: { findFirst: vi.fn(), updateMany: vi.fn() },
};

const Stored = {
	id: 1n,
	streamerId: "123",
	subscriptionId: "old",
	subscriptionType: "StreamOnline",
};

beforeEach(() => {
	vi.clearAllMocks();
	container.prisma = prismaMock as never;
	vi.mocked(areTwitchEventSubCredentialsSet).mockReturnValue(true);
	prismaMock.twitchSubscription.findFirst.mockResolvedValue(Stored);
	prismaMock.twitchSubscription.updateMany.mockResolvedValue({ count: 1 });
	vi.spyOn(container.logger, "error").mockImplementation(() => undefined);
});

const revoke = (status = "notification_failures_exceeded") =>
	handleSubscriptionRevoked({ id: "old", status });

describe("handleSubscriptionRevoked", () => {
	it("asks for the subscription again and stores the new id", async () => {
		vi.mocked(addEventSubscription).mockResolvedValue({ id: "new" } as never);

		expect(await revoke()).toBe("renewed");
		expect(addEventSubscription).toHaveBeenCalledWith("123", "stream.online");
		expect(prismaMock.twitchSubscription.updateMany).toHaveBeenCalledWith({
			where: { subscriptionId: "old" },
			data: { subscriptionId: "new", revokedReason: null },
		});
	});

	it("does not leave an orphan behind when the renewal cannot be stored", async () => {
		vi.mocked(addEventSubscription).mockResolvedValue({ id: "new" } as never);
		prismaMock.twitchSubscription.updateMany.mockRejectedValueOnce(
			new Error("down"),
		);

		expect(await revoke()).toBe("recorded");
		expect(removeEventSubscription).toHaveBeenCalledWith("new");
		expect(prismaMock.twitchSubscription.updateMany).toHaveBeenLastCalledWith({
			where: { subscriptionId: "old" },
			data: { revokedReason: "notification_failures_exceeded" },
		});
	});

	it("removes the replacement when the row vanished during the renewal", async () => {
		vi.mocked(addEventSubscription).mockResolvedValue({ id: "new" } as never);
		prismaMock.twitchSubscription.updateMany.mockResolvedValue({ count: 0 });

		expect(await revoke()).toBe("recorded");
		expect(removeEventSubscription).toHaveBeenCalledWith("new");
	});

	it("records the reason when Twitch refuses", async () => {
		vi.mocked(addEventSubscription).mockRejectedValue(new Error("nope"));

		expect(await revoke()).toBe("recorded");
		expect(prismaMock.twitchSubscription.updateMany).toHaveBeenCalledWith({
			where: { subscriptionId: "old" },
			data: { revokedReason: "notification_failures_exceeded" },
		});
	});

	it("does not try again for a streamer who deleted their account", async () => {
		expect(await revoke("user_removed")).toBe("recorded");
		expect(addEventSubscription).not.toHaveBeenCalled();
	});

	it("records the reason when EventSub cannot be used at all", async () => {
		vi.mocked(areTwitchEventSubCredentialsSet).mockReturnValue(false);

		expect(await revoke()).toBe("recorded");
		expect(addEventSubscription).not.toHaveBeenCalled();
	});

	it("ignores a subscription it does not know", async () => {
		prismaMock.twitchSubscription.findFirst.mockResolvedValue(null);

		expect(await revoke()).toBe("ignored");
		expect(prismaMock.twitchSubscription.updateMany).not.toHaveBeenCalled();
	});
});
