import type { Events } from "#lib/types";
import type { TwitchStreamStatus } from "#lib/types/AnalyticsSchema";
import type { IntegerString } from "@skyra/env-utilities";
import type {
  TwitchEventSubEvent,
  TwitchEventSubOnlineEvent,
} from "@skyra/twitch-helpers";

declare module "@skyra/http-framework-i18n" {
  interface Client {
    emit(
      event: Events.TwitchStreamHookedAnalytics,
      status: TwitchStreamStatus,
    ): boolean;
    emit(
      event: Events.TwitchStreamOnline,
      data: TwitchEventSubOnlineEvent,
    ): boolean;
    emit(event: Events.TwitchStreamOffline, data: TwitchEventSubEvent): boolean;
    emit(event: string | symbol, ...args: any[]): boolean;
  }
}
declare module "@skyra/env-utilities" {
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
