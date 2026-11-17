import type { SocialProviderName } from "#lib/setup/prisma";
import type { Result } from "@sapphire/result";
import { TwitchSubscriptionType } from "#generated/prisma";
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

export interface AddTwitchBody {
	/** The login a member types, as `/subscriptions twitch add` takes it. */
	streamer: string;
	channelId: bigint;
	type: TwitchSubscriptionType;
	message: string | null;
}

/** A Twitch login: up to 25 letters, digits and underscores. Twitch says whether it exists. */
const TwitchLoginPattern = /^\w{1,25}$/;

export function parseAddTwitchBody(
	body: Result<unknown, unknown>,
): AddTwitchBody | null {
	const value = body.unwrapOr(null);
	if (!isObject(value)) return null;

	const { streamer, channelId, type, message } = value as Record<
		string,
		unknown
	>;
	if (typeof streamer !== "string" || typeof channelId !== "string") {
		return null;
	}
	// The same login with or without the @ a member may copy from Twitch.
	const login = streamer.trim().replace(/^@/, "");
	if (!TwitchLoginPattern.test(login)) return null;

	if (type !== "StreamOnline" && type !== "StreamOffline") return null;

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
		streamer: login,
		channelId: channel,
		type: TwitchSubscriptionType[type],
		message: trimmedMessage === "" ? null : trimmedMessage,
	};
}

/** What an edit changes. A key that is absent keeps its value. */
export interface EditSubscriptionBody {
	channelId?: bigint;
	/** `null`, or an empty text, removes the message. */
	message?: string | null;
}

/**
 * The account, the provider and, for Twitch live, the event name the subscription, so an edit
 * cannot change them: those are a removal and an add. A body that changes nothing is refused.
 */
export function parseEditSubscriptionBody(
	body: Result<unknown, unknown>,
): EditSubscriptionBody | null {
	const value = body.unwrapOr(null);
	if (!isObject(value)) return null;

	const { channelId, message } = value as Record<string, unknown>;
	const edit: EditSubscriptionBody = {};
	if (channelId !== undefined) {
		if (typeof channelId !== "string") return null;
		const channel = parseSnowflake(channelId);
		if (channel === null) return null;
		edit.channelId = channel;
	}
	if (message !== undefined) {
		if (message !== null && typeof message !== "string") return null;
		const trimmed = message?.trim() ?? "";
		if (trimmed.length > MaximumMessageLength) return null;
		edit.message = trimmed === "" ? null : trimmed;
	}
	return edit.channelId === undefined && edit.message === undefined
		? null
		: edit;
}
