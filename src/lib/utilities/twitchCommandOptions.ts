import type { TwitchEvent } from "#utils/subscriptionProviders";
import type { APIChannel } from "discord-api-types/v10";
import { TwitchSubscriptionType } from "#generated/prisma";
import { SlashCommandStringOption } from "@discordjs/builders";
import {
	applyLocalizedBuilder,
	createSelectMenuChoiceName,
} from "@wolfstar/plugin-i18next";

export interface TwitchEventOptions {
	streamer: string;
	channel: APIChannel;
	event: TwitchEvent;
	message?: string | null;
	keywords?: string;
	exclude_keywords?: string;
}

export function createTwitchEventOption(required = true) {
	return applyLocalizedBuilder(
		new SlashCommandStringOption(),
		"commands/twitch:optionsEventName",
		"commands/twitch:optionsEventDescription",
	)
		.setRequired(required)
		.addChoices(
			...(["live", "offline", "video", "clip"] as const).map((event) =>
				createSelectMenuChoiceName(`commands/twitch:events.${event}`, {
					value: event,
				}),
			),
		);
}

export function getTwitchLiveType(event: TwitchEvent) {
	return event === "offline"
		? TwitchSubscriptionType.StreamOffline
		: TwitchSubscriptionType.StreamOnline;
}
