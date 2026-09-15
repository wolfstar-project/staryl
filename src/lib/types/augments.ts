import type { StarylEvents, TwitchStreamStatus } from "#types";
import type { IntegerString } from "@wolfstar/env-utilities";
import type {
	TwitchEventSubEvent,
	TwitchEventSubOnlineEvent,
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
	}
}
