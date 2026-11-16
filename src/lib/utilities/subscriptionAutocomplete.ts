import type { Command } from "@wolfstar/http-framework";
import { getSocialProvider } from "#social/registry";
import { getGuildSocialSubscriptions } from "#social/subscriptions";
import { getSubscriptionProviders } from "#utils/subscriptionProviders";
import { cutText } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";

/** Discord's limits on one autocomplete answer. */
const MaximumChoices = 25;
const MaximumChoiceLength = 100;

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
	if (!trimmed) return interaction.replyEmpty();

	const provider = getSubscriptionProviders(interaction)
		.map(getSocialProvider)
		.find(
			(entry) => entry?.searchTargets && entry.getAuthRequirements().satisfied,
		);
	if (!provider?.searchTargets) return interaction.replyEmpty();

	const result = await provider.searchTargets(trimmed);
	if (result.isErr()) {
		// Searches run on every keystroke, so a failure here is expected noise, not an incident.
		container.logger.debug(
			`[subscriptions] ${provider.name} account search failed: ${result.unwrapErr()._tag}`,
		);
		return interaction.replyEmpty();
	}

	return interaction.reply({
		choices: result
			.unwrap()
			// A longer value cannot be sent back as a choice; the member can still type it.
			.filter(({ value }) => value.length <= MaximumChoiceLength)
			.slice(0, MaximumChoices)
			.map(({ name, value }) => ({
				name: cutText(name, MaximumChoiceLength),
				value,
			})),
	});
}
