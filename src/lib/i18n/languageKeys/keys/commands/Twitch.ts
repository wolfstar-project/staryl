import { FT, T } from "@wolfstar/plugin-i18next";

export const RootName = T("commands/twitch:name");
export const RootDescription = T("commands/twitch:description");

export const AddName = T("commands/twitch:addName");
export const AddDescription = T("commands/twitch:addDescription");

export const RemoveName = T("commands/twitch:removeName");
export const RemoveDescription = T("commands/twitch:removeDescription");
export const TestName = T("commands/twitch:testName");
export const TestDescription = T("commands/twitch:testDescription");
export const ResetName = T("commands/twitch:resetName");
export const ResetDescription = T("commands/twitch:resetDescription");
export const ShowName = T("commands/twitch:showName");
export const ShowDescription = T("commands/twitch:showDescription");
export const OptionsStreamerName = T("commands/twitch:optionsStreamerName");
export const OptionsStreamerDescription = T(
	"commands/twitch:optionsStreamerDescription",
);
export const OptionsChannelName = T("commands/twitch:optionsChannelName");
export const OptionsChannelDescription = T(
	"commands/twitch:optionsChannelDescription",
);
export const OptionsTypeName = T("commands/twitch:optionsTypeName");
export const OptionsTypeDescription = T(
	"commands/twitch:optionsTypeDescription",
);
export const OptionsMessageName = T("commands/twitch:optionsMessageName");
export const OptionsMessageDescription = T(
	"commands/twitch:optionsMessageDescription",
);
export const OptionsTypeChoiceOnline = T(
	"commands/twitch:optionsTypeChoiceOnline",
);
export const OptionsTypeChoiceOffline = T(
	"commands/twitch:optionsTypeChoiceOffline",
);
export const StreamerNotFound = T("commands/twitch:streamerNotFound");
export const StatusValues = T<[string, string]>("commands/twitch:statusValues");
export const InvalidStatus = T("commands/twitch:invalidStatus");
export const AddDuplicated = T("commands/twitch:addDuplicated");
export const AddSuccessOffline = FT<{ name: string; channel: string }>(
	"commands/twitch:addSuccessOffline",
);
export const AddSuccessLive = FT<{ name: string; channel: string }>(
	"commands/twitch:addSuccessLive",
);
export const AddMessageForOfflineRequired = T(
	"commands/twitch:addMessageForOfflineRequired",
);
export const AddFailedTwitch = T("commands/twitch:addFailedTwitch");
export const AddFailedDatabase = T("commands/twitch:addFailedDatabase");
export const RemoveFailed = T("commands/twitch:removeFailed");
export const ResetFailed = T("commands/twitch:resetFailed");
export const TestSuccess = FT<{ channel: string }>(
	"commands/twitch:testSuccess",
);
export const TestFailed = T("commands/twitch:testFailed");
export const TestFailedGuild = FT<{ channel: string }>(
	"commands/twitch:testFailedGuild",
);
export const TestFailedChannel = FT<{ channel: string }>(
	"commands/twitch:testFailedChannel",
);
export const TestFailedPermissions = FT<{ channel: string }>(
	"commands/twitch:testFailedPermissions",
);
export const TestFailedSend = FT<{ channel: string }>(
	"commands/twitch:testFailedSend",
);
export const TestMissingMessage = T("commands/twitch:testMissingMessage");
export const NoSubscriptions = T("commands/twitch:noSubscriptions");
export const RemoveStreamerNotSubscribed = FT<{ streamer: string }>(
	"commands/twitch:removeStreamerNotSubscribed",
);
export const RemoveNotToProvidedChannel = FT<{ channel: string }>(
	"commands/twitch:removeNotToProvidedChannel",
);
export const RemoveStreamerStatusNotMatch = FT<{
	streamer: string;
	status: string;
}>("commands/twitch:removeStreamerStatusNotMatch");
export const RemoveSuccessOffline = FT<{ name: string; channel: string }>(
	"commands/twitch:removeSuccessOffline",
);
export const RemoveSuccessLive = FT<{ name: string; channel: string }>(
	"commands/twitch:removeSuccessLive",
);
export const ResetSuccess = FT<{ count: number }>(
	"commands/twitch:resetSuccess",
);
export const ShowStreamerNotSubscribed = T(
	"commands/twitch:showStreamerNotSubscribed",
);
export const ShowStatus = T<{ live: string; offline: string }>(
	"commands/twitch:showStatus",
);
export const ShowUnknownUser = T("commands/twitch:showUnknownUser");
export const ShowEmbedTitle = T("commands/twitch:showEmbedTitle");
