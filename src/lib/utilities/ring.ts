import { container } from "@wolfstar/http-framework";
import { Json, safeTimedFetch } from "@wolfstar/safe-fetch";

/** The limits Ring keeps for a guild (`GET /guilds/:id` with Staryl's token). */
export interface RingLimits {
	maximumYouTubeSubscriptions: number;
	/** Twitch live notifications: each streamer and event of a channel counts once. */
	maximumTwitchSubscriptions: number;
	maximumRedditSubscriptions: number;
}

/**
 * What a guild may hold when Ring says nothing: its free values. They match the defaults of
 * Ring's `LimitDefinitions`, so a guild gets the same limits whether Ring answers or not.
 */
export const DefaultLimits = {
	maximumYouTubeSubscriptions: 10,
	maximumTwitchSubscriptions: 15,
	maximumRedditSubscriptions: 30,
} as const satisfies RingLimits;

/** How long a write waits on Ring before it goes on with the free values. */
const RingTimeout = 1000;

/**
 * Reads a guild's limits from Ring. Without `INTERNAL_RING_URL` and `INTERNAL_RING_TOKEN`, or when
 * Ring does not answer in time, the guild gets {@link DefaultLimits}: a member is never refused an
 * add because Ring is down, and never given more than the free values either.
 */
export async function readGuildLimits(guildId: bigint): Promise<RingLimits> {
	const url = process.env.INTERNAL_RING_URL;
	const token = process.env.INTERNAL_RING_TOKEN;
	if (!url || !token) return DefaultLimits;

	const result = await Json<object>(
		safeTimedFetch(`${url}/${guildId}`, RingTimeout, {
			headers: { authorization: token, "content-type": "application/json" },
		}),
	);
	if (result.isErr()) {
		container.logger.warn(
			`[ring] Could not read the limits of guild ${guildId}, using the free values`,
			result.unwrapErr(),
		);
		return DefaultLimits;
	}
	return parseRingLimits(result.unwrap());
}

/**
 * A field Ring does not send, or sends broken, takes its free value: Ring may predate it. A body
 * that is no object at all, `null` included, gives every field its free value.
 */
export function parseRingLimits(value: unknown): RingLimits {
	const fields: Record<string, unknown> =
		typeof value === "object" && value !== null ? { ...value } : {};
	const read = (field: keyof RingLimits) => {
		const limit = fields[field];
		return typeof limit === "number" &&
			Number.isSafeInteger(limit) &&
			limit >= 0
			? limit
			: DefaultLimits[field];
	};
	return {
		maximumYouTubeSubscriptions: read("maximumYouTubeSubscriptions"),
		maximumTwitchSubscriptions: read("maximumTwitchSubscriptions"),
		maximumRedditSubscriptions: read("maximumRedditSubscriptions"),
	};
}
