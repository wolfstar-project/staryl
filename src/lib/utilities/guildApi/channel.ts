import type { ApiResponse } from "@wolfstar/plugin-api";
import { socialDelivery } from "#social/notifications";
import { NotificationDeliveryError } from "#utils/notificationDelivery";
import { ChannelType } from "discord-api-types/v10";

/** What the caller reads when the channel cannot receive a notification. */
const ChannelErrors = {
	[NotificationDeliveryError.GuildUnavailable]: [409, "guild-unavailable"],
	[NotificationDeliveryError.ChannelNotFound]: [422, "channel-not-found"],
	[NotificationDeliveryError.MissingPermissions]: [422, "missing-permissions"],
	// Checking a channel posts nothing, so this is here for the type. It gets a code of its own all
	// the same: "the channel is gone" would send a member to fix what is not broken.
	[NotificationDeliveryError.SendFailed]: [422, "send-failed"],
} as const satisfies Record<
	NotificationDeliveryError,
	readonly [number, string]
>;

/**
 * Checks that a channel can receive notifications, or answers why not and returns `false`.
 *
 * A command gets a channel Discord already vetted. The guild API gets an id from outside, so it is
 * checked against the guild, which also proves the bot can post there before anything is saved.
 * Both the social and the Twitch live notifications need Embed Links, which this checks.
 */
export async function assertNotificationChannel(
	response: ApiResponse,
	guildId: bigint,
	channelId: bigint,
): Promise<boolean> {
	const target = await socialDelivery.prepare(guildId, channelId);
	if (target.isErr()) {
		const [status, code] = ChannelErrors[target.unwrapErr()];
		response.error(status, code);
		return false;
	}

	const { type } = target.unwrap().channel;
	if (
		type !== ChannelType.GuildText &&
		type !== ChannelType.GuildAnnouncement
	) {
		response.error(422, "channel-not-supported");
		return false;
	}
	return true;
}
