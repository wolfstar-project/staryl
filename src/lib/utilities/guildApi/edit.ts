import type { EditSubscriptionBody } from "#utils/guildApi/body";
import type { ApiResponse } from "@wolfstar/plugin-api";
import { assertNotificationChannel } from "#utils/guildApi/channel";

/** Why a row could not be written. Any other failure is the database's. */
export type EditWriteError = "duplicate" | "subscription-not-found";

/**
 * Reads the two failures an edit expects from Prisma: the channel already has the same
 * subscription (P2002), or the row went away since it was read (P2025).
 */
export function toEditWriteError(error: unknown): EditWriteError | null {
	// Prisma's errors are class instances, so a check for a plain object would miss them.
	if (typeof error !== "object" || error === null) return null;
	const { code } = error as { code?: unknown };
	if (code === "P2002") return "duplicate";
	if (code === "P2025") return "subscription-not-found";
	return null;
}

export const EditWriteErrors = {
	duplicate: 409,
	"subscription-not-found": 404,
} as const satisfies Record<EditWriteError, number>;

/**
 * Checks the channel an edit moves the subscription to, or answers why not and returns `false`.
 * An edit that keeps the channel checks nothing: the channel was checked when it was set.
 */
export function assertEditChannel(
	response: ApiResponse,
	guildId: bigint,
	current: bigint,
	edit: EditSubscriptionBody,
): Promise<boolean> | boolean {
	if (edit.channelId === undefined || edit.channelId === current) return true;
	return assertNotificationChannel(response, guildId, edit.channelId);
}

/**
 * The columns an edit writes. A move clears the last delivery error, which was the old channel's.
 * The seen items move with the row, so the new channel is not sent what the old one already got.
 */
export function toEditData(current: bigint, edit: EditSubscriptionBody) {
	const moves = edit.channelId !== undefined && edit.channelId !== current;
	return {
		...(moves ? { channelId: edit.channelId } : {}),
		...(edit.message === undefined ? {} : { message: edit.message }),
	};
}
