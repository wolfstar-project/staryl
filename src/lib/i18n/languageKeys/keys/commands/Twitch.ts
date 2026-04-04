import { FT, T } from "@skyra/http-framework-i18n";

export const TwitchSubscriptionDescription = T(
  "commands/twitch:twitchSubscriptionDescription",
);
export const TwitchSubscriptionAddDescription = T(
  "commands/twitch:twitchSubscriptionAddDescription",
);
export const TwitchSubscriptionRemoveDescription = T(
  "commands/twitch:twitchSubscriptionRemoveDescription",
);
export const TwitchSubscriptionStreamerNotFound = T(
  "commands/twitch:twitchSubscriptionStreamerNotFound",
);
export const TwitchSubscriptionStatusValues = T<[string, string]>(
  "commands/twitch:twitchSubscriptionStatusValues",
);
export const TwitchSubscriptionInvalidStatus = T(
  "commands/twitch:twitchSubscriptionInvalidStatus",
);
export const TwitchSubscriptionAddDuplicated = T(
  "commands/twitch:twitchSubscriptionAddDuplicated",
);
export const TwitchSubscriptionAddSuccessOffline = FT<{
  name: string;
  channel: string;
}>("commands/twitch:twitchSubscriptionAddSuccessOffline");
export const TwitchSubscriptionAddSuccessLive = FT<{
  name: string;
  channel: string;
}>("commands/twitch:twitchSubscriptionAddSuccessLive");
export const TwitchSubscriptionAddMessageForOfflineRequired = T(
  "commands/twitch:twitchSubscriptionAddMessageForOfflineRequired",
);
export const TwitchSubscriptionRemoveStreamerNotSubscribed = FT<{
  streamer: string;
}>("commands/twitch:twitchSubscriptionRemoveStreamerNotSubscribed");
export const TwitchSubscriptionRemoveNotToProvidedChannel = FT<{
  channel: string;
}>("commands/twitch:twitchSubscriptionRemoveNotToProvidedChannel");
export const TwitchSubscriptionRemoveStreamerStatusNotMatch = FT<{
  streamer: string;
  status: string;
}>("commands/twitch:twitchSubscriptionRemoveStreamerStatusNotMatch");
export const TwitchSubscriptionRemoveSuccessOffline = FT<{
  name: string;
  channel: string;
}>("commands/twitch:twitchSubscriptionRemoveSuccessOffline");
export const TwitchSubscriptionRemoveSuccessLive = FT<{
  name: string;
  channel: string;
}>("commands/twitch:twitchSubscriptionRemoveSuccessLive");
export const TwitchSubscriptionNoSubscriptions = T(
  "commands/twitch:twitchSubscriptionNoSubscriptions",
);
export const TwitchSubscriptionResetSuccess = FT<{ count: number }>(
  "commands/twitch:twitchSubscriptionResetSuccess",
);
export const TwitchSubscriptionShowStreamerNotSubscribed = T(
  "commands/twitch:twitchSubscriptionShowStreamerNotSubscribed",
);
export const TwitchSubscriptionShowStatus = T<{
  live: string;
  offline: string;
}>("commands/twitch:twitchSubscriptionShowStatus");
export const TwitchSubscriptionShowUnknownUser = T(
  "commands/twitch:twitchSubscriptionShowUnknownUser",
);
