import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { createHash, timingSafeEqual } from "node:crypto";

export interface GuildRequest {
	guildId: bigint;
	/** The Discord id of the member the caller acts for, when it names one. Logged, never trusted. */
	actor: string | null;
}

const SnowflakePattern = /^\d{17,20}$/;
const BearerPattern = /^Bearer (.+)$/;

/** The header a caller names its member in, so a write can be traced to a person. */
export const ActorHeader = "x-actor-id";

export function parseSnowflake(value: string | undefined): bigint | null {
	return value !== undefined && SnowflakePattern.test(value)
		? BigInt(value)
		: null;
}

/**
 * Lets a request of the guild API through, or answers it and returns `null`.
 *
 * `GUILD_API_SECRET` is the only credential, and whoever holds it acts for every guild: the caller
 * is the one that checks its member may manage the guild. Without the variable the API is closed,
 * so a deployment that forgot it does not serve the routes to anyone.
 */
export function authorizeGuildRequest(
	request: ApiRequest,
	response: ApiResponse,
): GuildRequest | null {
	const secret = process.env.GUILD_API_SECRET;
	if (!secret) {
		response.error(503, "guild-api-disabled");
		return null;
	}

	const token = BearerPattern.exec(request.headers.authorization ?? "")?.[1];
	if (token === undefined || !isSameSecret(token, secret)) {
		response.error(401, "unauthorized");
		return null;
	}

	const guildId = parseSnowflake(request.params.guild);
	if (guildId === null) {
		response.error(400, "invalid-guild");
		return null;
	}

	const actor = request.headers[ActorHeader];
	return {
		guildId,
		actor:
			typeof actor === "string" && SnowflakePattern.test(actor) ? actor : null,
	};
}

/** Compared as digests: `timingSafeEqual` needs equal lengths, and a length is a hint too. */
function isSameSecret(given: string, expected: string) {
	return timingSafeEqual(digest(given), digest(expected));
}

function digest(value: string) {
	return createHash("sha256").update(value).digest();
}
