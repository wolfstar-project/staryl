import type { StarylEvents, TwitchStreamStatus } from "#types";
import type { IntegerString } from "@wolfstar/env-utilities";
import type {
	TwitchEventSubEvent,
	TwitchEventSubOnlineEvent,
	TwitchEventSubResult,
} from "@wolfstar/twitch-helpers";

declare module "@wolfstar/http-framework" {
	interface Client {
		emit(
			event: StarylEvents.TwitchStreamHookedAnalytics,
			status: TwitchStreamStatus,
		): boolean;
		emit(
			event: StarylEvents.TwitchStreamOnline,
			data: TwitchEventSubOnlineEvent,
		): boolean;
		emit(
			event: StarylEvents.TwitchStreamOffline,
			data: TwitchEventSubEvent,
		): boolean;
		emit(
			event: StarylEvents.TwitchSubscriptionRevoked,
			subscription: TwitchEventSubResult,
		): boolean;
		emit(event: string | symbol, ...args: any[]): boolean;
	}
}
declare module "@wolfstar/env-utilities" {
	interface Env {
		CLIENT_VERSION: string;

		DISCORD_CLIENT_ID: string;
		DISCORD_PUBLIC_KEY: string;

		HTTP_ADDRESS: string;
		HTTP_PORT: IntegerString;

		REGISTRY_GUILD_ID: string;

		API_ADDRESS: string;
		API_PORT: IntegerString;

		INTERNAL_RING_URL: string;
		INTERNAL_RING_TOKEN: string;

		REDDIT_CLIENT_ID: string;
		REDDIT_CLIENT_SECRET: string;
		REDDIT_USERNAME: string;

		INSTAGRAM_APP_ID: string;
		INSTAGRAM_APP_SECRET: string;
		INSTAGRAM_REDIRECT_URI: string;
		SOCIAL_TOKEN_KEY: string;

		X_API_KEY: string;
		X_API_SECRET: string;
		X_ACCESS_TOKEN: string;
		X_ACCESS_SECRET: string;

		YOUTUBE_API_KEY: string;
		YOUTUBE_WEBSUB_CALLBACK: string;
		YOUTUBE_WEBSUB_SECRET: string;
	}
}
