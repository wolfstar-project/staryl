import type { SocialProviderName } from "#lib/setup/prisma";
import type { Result } from "@sapphire/result";
import { SocialProviderName as ProviderNames } from "#generated/prisma";
import { MaximumMessageLength } from "#twitch/subscriptions";
import { parseSnowflake } from "#utils/guildApi/auth";
import { MaximumTargetInputLength } from "#utils/guildApi/state";
import { isObject } from "@sapphire/utilities";

export interface SwitchBody {
	enabled: boolean;
}

export interface AddSubscriptionBody {
	provider: SocialProviderName;
	target: string;
	channelId: bigint;
	message: string | null;
}

/** A body that could not be read is as invalid as one of the wrong shape. */
export function parseSwitchBody(
	body: Result<unknown, unknown>,
): SwitchBody | null {
	const value = body.unwrapOr(null);
	if (!isObject(value)) return null;

	const { enabled } = value as Record<string, unknown>;
	return typeof enabled === "boolean" ? { enabled } : null;
}

export function parseAddSubscriptionBody(
	body: Result<unknown, unknown>,
): AddSubscriptionBody | null {
	const value = body.unwrapOr(null);
	if (!isObject(value)) return null;

	const { provider, target, channelId, message } = value as Record<
		string,
		unknown
	>;
	if (typeof provider !== "string" || !isProviderName(provider)) return null;
	if (typeof target !== "string" || typeof channelId !== "string") return null;

	const trimmedTarget = target.trim();
	if (trimmedTarget === "" || trimmedTarget.length > MaximumTargetInputLength) {
		return null;
	}

	const channel = parseSnowflake(channelId);
	if (channel === null) return null;

	if (
		message !== undefined &&
		message !== null &&
		typeof message !== "string"
	) {
		return null;
	}
	const trimmedMessage = message?.trim() ?? "";
	if (trimmedMessage.length > MaximumMessageLength) return null;

	return {
		provider,
		target: trimmedTarget,
		channelId: channel,
		message: trimmedMessage === "" ? null : trimmedMessage,
	};
}

function isProviderName(value: string): value is SocialProviderName {
	return Object.hasOwn(ProviderNames, value);
}
