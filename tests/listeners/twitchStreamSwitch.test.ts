import type {
	TwitchEventSubEvent,
	TwitchEventSubOnlineEvent,
} from "@wolfstar/twitch-helpers";
import { VirtualPath } from "@sapphire/pieces";
import { ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserListener as OfflineListener } from "../../src/listeners/twitch/twitchStreamOffline.ts";
import { UserListener as OnlineListener } from "../../src/listeners/twitch/twitchStreamOnline.ts";

const notifications = vi.hoisted(() => ({
	sendOnlineNotification: vi.fn(),
	sendOfflineNotification: vi.fn(),
}));
vi.mock("#twitch/notifications", () => notifications);

vi.mock("#twitch/subscriptions", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#twitch/subscriptions")>();
	return { ...actual, getStreamerById: vi.fn(async () => null) };
});

vi.mock("@wolfstar/twitch-helpers", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@wolfstar/twitch-helpers")>();
	return { ...actual, fetchStream: vi.fn(async () => null) };
});

const findFirst = vi.fn();

function makeListener<Piece>(
	ListenerClass: new (context: never) => Piece,
	name: string,
) {
	return new ListenerClass({
		name,
		path: VirtualPath,
		root: VirtualPath,
		store: container.stores.get("listeners"),
	} as never);
}

const event = {
	broadcaster_user_id: "123456789",
	broadcaster_user_login: "coolstreamer",
	broadcaster_user_name: "CoolStreamer",
	id: "0",
	type: "live",
	started_at: "2026-11-01T12:00:00.000Z",
};

function makeTwitchSubscription(streamerId: string) {
	const guildSubscription = (
		guildId: bigint,
		channelId: bigint,
		notificationsEnabled: boolean,
	) => ({
		guildId,
		channelId,
		message: "Stream update",
		subscriptionId: 1n,
		guild: { notificationsEnabled },
	});
	return {
		id: 1n,
		streamerId,
		guildSubscription: [
			guildSubscription(10n, 20n, false),
			guildSubscription(11n, 21n, true),
		],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	container.prisma = { twitchSubscription: { findFirst } } as never;
	notifications.sendOnlineNotification.mockResolvedValue(ok());
	notifications.sendOfflineNotification.mockResolvedValue(ok());
});

describe("a guild whose notifications are off", () => {
	it("gets no live notification, while the other guilds of the streamer do", async () => {
		// A streamer of its own per test: the drip remembers a channel it just posted in.
		findFirst.mockResolvedValue(makeTwitchSubscription("online-streamer"));
		const listener = makeListener(OnlineListener, "twitchStreamOnline");

		await listener.run({
			...event,
			broadcaster_user_id: "online-streamer",
		} as TwitchEventSubOnlineEvent);

		expect(notifications.sendOnlineNotification).toHaveBeenCalledTimes(1);
		expect(notifications.sendOnlineNotification).toHaveBeenCalledWith(
			expect.objectContaining({ guildId: 11n, channelId: 21n }),
		);
	});

	it("gets no offline notification either", async () => {
		findFirst.mockResolvedValue(makeTwitchSubscription("offline-streamer"));
		const listener = makeListener(OfflineListener, "twitchStreamOffline");

		await listener.run({
			...event,
			broadcaster_user_id: "offline-streamer",
		} as TwitchEventSubEvent);

		expect(notifications.sendOfflineNotification).toHaveBeenCalledTimes(1);
		expect(notifications.sendOfflineNotification).toHaveBeenCalledWith(
			expect.objectContaining({ guildId: 11n, channelId: 21n }),
		);
	});
});
