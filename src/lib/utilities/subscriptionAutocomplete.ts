import type { SocialProvider, TargetSuggestion } from "#social/provider";
import type { Command } from "@wolfstar/http-framework";
import { getSocialProvider } from "#social/registry";
import { getGuildSocialSubscriptions } from "#social/subscriptions";
import { getSubscriptionProviders } from "#utils/subscriptionProviders";
import { Time } from "@sapphire/time-utilities";
import { cutText } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";

/** Discord's limits on one autocomplete answer. */
const MaximumChoices = 25;
const MaximumChoiceLength = 100;

/** One letter matches too much to be worth a request. */
export const MinimumQueryLength = 2;
/** Discord drops an answer after 3 seconds, so a slower search is given up on to answer in time. */
const SearchDeadline = Time.Second * 2.5;
/**
 * Every keystroke would be a request otherwise, and they all share the budget of the provider with the poller,
 * Reddit's one app credential among them.
 */
const SearchCacheLifetime = Time.Minute;
const MaximumCachedSearches = 500;

const searchCache = new Map<
	string,
	{ expiresAt: number; suggestions: TargetSuggestion[] }
>();

/** The options naming an account to follow. The Twitch live commands still call it `streamer`. */
const TargetOptionNames: ReadonlySet<string> = new Set(["target", "streamer"]);

/**
 * Answers the autocomplete of every `/subscriptions` group. The group the member is in decides the
 * providers, so no group needs code of its own here.
 */
export function runSubscriptionAutocomplete(
	interaction: Command.AutocompleteInteraction,
	focused: string,
	query: string,
) {
	if (focused === "source") return autocompleteSource(interaction, query);
	if (TargetOptionNames.has(focused)) {
		return autocompleteTarget(interaction, query);
	}
	return interaction.replyEmpty();
}

/** The accounts the server already follows in this group, for the commands that act on one. */
async function autocompleteSource(
	interaction: Command.AutocompleteInteraction,
	query: string,
) {
	if (!interaction.guildId) return interaction.replyEmpty();

	const result = await getGuildSocialSubscriptions(BigInt(interaction.guildId));
	if (result.isErr()) {
		container.logger.error(
			"[subscriptions] Failed to read the guild subscriptions for autocomplete",
			result.unwrapErr(),
		);
		return interaction.replyEmpty();
	}

	const providers = getSubscriptionProviders(interaction);
	const needle = query.toLowerCase();
	// A source followed in several channels is listed once.
	const sources = new Map(
		result
			.unwrap()
			.filter(
				({ source }) =>
					providers.includes(source.provider) &&
					source.displayName.toLowerCase().includes(needle),
			)
			.map(({ source }) => [source.id, source]),
	);

	return interaction.reply({
		choices: [...sources.values()].slice(0, MaximumChoices).map((source) => ({
			name: cutText(
				`${source.provider}: ${source.displayName}`,
				MaximumChoiceLength,
			),
			value: String(source.id),
		})),
	});
}

/** Accounts on the network of this group that match what the member typed, for `add`. */
async function autocompleteTarget(
	interaction: Command.AutocompleteInteraction,
	query: string,
) {
	const trimmed = query.trim();
	if (trimmed.length < MinimumQueryLength) return interaction.replyEmpty();

	const provider = getSubscriptionProviders(interaction)
		.map(getSocialProvider)
		.find(canSearchTargets);
	if (!provider) return interaction.replyEmpty();

	const suggestions = await searchTargets(provider, trimmed);
	if (suggestions === null) return interaction.replyEmpty();

	return interaction.reply({ choices: toTargetChoices(suggestions) });
}

/**
 * The suggestions as Discord takes them in an autocomplete. The guild API answers the same list, so
 * the dashboard and the command offer the same accounts.
 */
export function toTargetChoices(
	suggestions: readonly TargetSuggestion[],
): TargetSuggestion[] {
	return (
		suggestions
			// A longer value cannot be sent back as a choice; the member can still type it.
			.filter(({ value }) => value.length <= MaximumChoiceLength)
			.slice(0, MaximumChoices)
			.map(({ name, value }) => ({
				name: cutText(name, MaximumChoiceLength),
				value,
			}))
	);
}

/** Whether `add` can suggest accounts of this provider: it has a search, and the credentials the search needs. */
export function canSearchTargets(
	provider: SocialProvider | undefined,
): provider is SocialProvider &
	Required<Pick<SocialProvider, "searchTargets">> {
	return (
		provider?.searchTargets !== undefined &&
		provider.getAuthRequirements().satisfied
	);
}

/**
 * Answers from the cache when the same search ran recently, or `null` when the search failed or ran
 * out of time. Shared by the autocomplete of `add` and the guild API, so both spend one budget.
 */
export async function searchTargets(
	provider: SocialProvider & Required<Pick<SocialProvider, "searchTargets">>,
	query: string,
) {
	const key = `${provider.name}:${query.toLowerCase()}`;
	const now = Date.now();
	const cached = searchCache.get(key);
	if (cached && cached.expiresAt > now) return cached.suggestions;

	const result = await withDeadline(
		provider.searchTargets(query),
		SearchDeadline,
	);
	if (result === null || result.isErr()) {
		// Searches run on every keystroke, so a failure here is expected noise, not an incident.
		container.logger.debug(
			`[subscriptions] ${provider.name} account search failed: ${result?.unwrapErr()._tag ?? "too slow"}`,
		);
		return null;
	}

	const suggestions = result.unwrap();
	searchCache.delete(key);
	searchCache.set(key, { expiresAt: now + SearchCacheLifetime, suggestions });
	// A Map keeps insertion order, so the first key is the oldest search:
	if (searchCache.size > MaximumCachedSearches) {
		searchCache.delete(searchCache.keys().next().value!);
	}
	return suggestions;
}

/** Settles with `null` once the time is up, leaving the promise to finish unobserved. */
function withDeadline<T>(promise: Promise<T>, milliseconds: number) {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<null>((resolve) => {
		timer = setTimeout(resolve, milliseconds, null);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
