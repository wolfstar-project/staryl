import { FT, T } from "@wolfstar/plugin-i18next";

export const EmbedDescription = FT<{ userName: string }, string>(
	"events/twitch:embedDescription",
);
export const EmbedDescriptionWithGame = FT<
	{ userName: string; gameName: string },
	string
>("events/twitch:embedDescriptionWithGame");
export const OfflinePostfix = T<string>("events/twitch:offlinePostfix");
export const TestNotice = T<string>("events/twitch:testNotice");
export const TestPlaceholderTitle = T<string>(
	"events/twitch:testPlaceholderTitle",
);
