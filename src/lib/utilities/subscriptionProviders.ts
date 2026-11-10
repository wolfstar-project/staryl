import type { SocialProviderName } from "#generated/prisma";
import type { SocialFilterName } from "#social/filters";
import type { SlashCommandSubcommandBuilder } from "@discordjs/builders";
import type { Command } from "@wolfstar/http-framework";
import { getSocialProvider } from "#social/registry";
import { SubscriptionsCommandName } from "#twitch/subscriptions";
import { RegisterAsSubcommandGroup } from "@wolfstar/plugin-subcommands-advanced";
import { ApplicationCommandOptionType } from "discord-api-types/v10";

/** Public groups are independent of the services used to deliver their notifications. */
export const SubscriptionProviderGroups = [
	{ group: "rss", provider: "Rss" },
	{ group: "reddit", provider: "Reddit" },
	{ group: "bluesky", provider: "Bluesky" },
	{ group: "mastodon", provider: "Mastodon" },
	{ group: "youtube", provider: "YouTube" },
	{ group: "x", provider: "X" },
	{ group: "instagram", provider: "Instagram" },
	{ group: "tiktok", provider: "TikTok" },
] as const;

export type TwitchEvent = "live" | "offline" | "video" | "clip";

export function getSubscriptionGroup(
	interaction: Pick<
		Command.ChatInputInteraction | Command.AutocompleteInteraction,
		"data"
	>,
) {
	const group = interaction.data.options?.[0];
	return group?.type === ApplicationCommandOptionType.SubcommandGroup
		? group.name
		: null;
}

export function getSubscriptionProviders(
	interaction: Pick<
		Command.ChatInputInteraction | Command.AutocompleteInteraction,
		"data"
	>,
	event?: TwitchEvent,
): readonly SocialProviderName[] {
	const group = getSubscriptionGroup(interaction);
	if (group === "twitch") {
		if (event === "video") return ["TwitchVideos"];
		if (event === "clip") return ["TwitchClips"];
		return event ? [] : ["TwitchVideos", "TwitchClips"];
	}
	const provider = SubscriptionProviderGroups.find(
		(entry) => entry.group === group,
	)?.provider;
	return provider ? [provider] : [];
}

/** One piece serves the shared action in each group; the incoming group supplies its scope. */
export function RegisterProviderSubcommand(
	builder: (
		builder: SlashCommandSubcommandBuilder,
		provider: SocialProviderName,
	) => SlashCommandSubcommandBuilder,
	kind: "add" | "connect" | "manage" = "manage",
) {
	return <
		T extends Parameters<ReturnType<typeof RegisterAsSubcommandGroup>>[0],
	>(
		target: T,
	): T => {
		for (const { group, provider } of SubscriptionProviderGroups) {
			const connected = provider === "Instagram" || provider === "TikTok";
			if ((kind === "add" && connected) || (kind === "connect" && !connected))
				continue;
			target = RegisterAsSubcommandGroup(
				SubscriptionsCommandName,
				group,
				(option) => builder(option, provider),
			)(target);
		}
		return target;
	};
}

/** Hide provider-specific options that would only fail validation after submission. */
export function filterProviderOptions(
	builder: SlashCommandSubcommandBuilder,
	provider: SocialProviderName,
) {
	const supported = getSocialProvider(provider)?.supportedFilters;
	const filters = new Map<string, SocialFilterName>([
		["keywords", "includeKeywords"],
		["exclude_keywords", "excludeKeywords"],
		["flairs", "flairs"],
		["minimum_score", "minimumScore"],
		["shorts", "shorts"],
		["exclude_replies", "excludeReplies"],
		["exclude_reposts", "excludeReposts"],
	]);
	const options = builder.options.filter((option) => {
		const filter = filters.get(option.toJSON().name);
		return !filter || supported?.has(filter);
	});
	builder.options.splice(0, builder.options.length, ...options);
	return builder;
}
