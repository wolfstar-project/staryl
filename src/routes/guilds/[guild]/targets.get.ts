import type { SocialProviderName } from "#lib/setup/prisma";
import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { SocialProviderName as ProviderNames } from "#generated/prisma";
import { getSocialProvider } from "#social/registry";
import { authorizeGuildRequest } from "#utils/guildApi/auth";
import {
	canSearchTargets,
	MinimumQueryLength,
	searchTargets,
	toTargetChoices,
} from "#utils/subscriptionAutocomplete";
import { Route } from "@wolfstar/plugin-api";

/** Longer than any handle, feed or channel a search could match. */
const MaximumQueryLength = 100;

/**
 * Twitch live has no provider of its own: it follows a channel by its login, which is what the
 * Twitch videos search suggests.
 */
function searchProvider(source: string) {
	if (source === "TwitchLive") return getSocialProvider("TwitchVideos");
	return Object.hasOwn(ProviderNames, source)
		? getSocialProvider(source as SocialProviderName)
		: undefined;
}

/**
 * `GET /guilds/:guild/targets?source=<provider or TwitchLive>&query=<text>`: the accounts that match
 * what a member is typing, as the autocomplete of `/subscriptions <provider> add` offers them. A
 * source without a search, a short query, or a search that fails or is slow answers no suggestion:
 * the member can always type the target in full.
 */
export class UserRoute extends Route {
	public async run(request: ApiRequest, response: ApiResponse) {
		const guild = authorizeGuildRequest(request, response);
		if (guild === null) return;

		const { source, query } = request.query;
		if (typeof source !== "string" || typeof query !== "string") {
			response.error(400, "invalid-query");
			return;
		}

		const trimmed = query.trim();
		const provider = searchProvider(source);
		if (
			trimmed.length < MinimumQueryLength ||
			trimmed.length > MaximumQueryLength ||
			!canSearchTargets(provider)
		) {
			response.json({ suggestions: [] });
			return;
		}

		const suggestions = (await searchTargets(provider, trimmed)) ?? [];
		response.json({ suggestions: toTargetChoices(suggestions) });
	}
}
