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
	{
		group: "rss",
		provider: "Rss",
		name: "commands/subscriptions:groupRssName",
		description: "commands/subscriptions:groupRssDescription",
	},
	{
		group: "reddit",
		provider: "Reddit",
		name: "commands/subscriptions:groupRedditName",
		description: "commands/subscriptions:groupRedditDescription",
	},
	{
		group: "bluesky",
		provider: "Bluesky",
		name: "commands/subscriptions:groupBlueskyName",
		description: "commands/subscriptions:groupBlueskyDescription",
	},
	{
		group: "mastodon",
		provider: "Mastodon",
		name: "commands/subscriptions:groupMastodonName",
		description: "commands/subscriptions:groupMastodonDescription",
	},
	{
		group: "youtube",
		provider: "YouTube",
		name: "commands/subscriptions:groupYoutubeName",
		description: "commands/subscriptions:groupYoutubeDescription",
	},
	{
		group: "x",
		provider: "X",
		name: "commands/subscriptions:groupXName",
		description: "commands/subscriptions:groupXDescription",
	},
	{
		group: "instagram",
		provider: "Instagram",
		name: "commands/subscriptions:groupInstagramName",
		description: "commands/subscriptions:groupInstagramDescription",
	},
	{
		group: "tiktok",
		provider: "TikTok",
		name: "commands/subscriptions:groupTiktokName",
		description: "commands/subscriptions:groupTiktokDescription",
	},
] as const;

/** Every group of `/subscriptions`, in the order Discord lists them. */
export const SubscriptionGroups = [
	{
		group: "twitch",
		name: "commands/twitch:name",
		description: "commands/twitch:description",
	},
	...SubscriptionProviderGroups,
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
