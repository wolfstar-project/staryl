import type { TwitchChannelSearchResult } from "#twitch/subscriptions";
import type { TwitchHelixResponse } from "@wolfstar/twitch-helpers";
import { getGuildSocialSubscriptions } from "#social/subscriptions";
import { getSubscriptionProviders } from "#utils/subscriptionProviders";
import { cutText } from "@sapphire/utilities";
import { Command, RegisterCommand } from "@wolfstar/http-framework";
import { applyLocalizedBuilder } from "@wolfstar/plugin-i18next";
import { Subcommand } from "@wolfstar/plugin-subcommands-advanced";
import { getRequest } from "@wolfstar/twitch-helpers";
import {
	ApplicationIntegrationType,
	InteractionContextType,
	PermissionFlagsBits,
} from "discord-api-types/v10";

/**
 * The parent of every subscription subcommand. Each social network owns a subcommand group declared
 * here, and its subcommands live in their own classes under `commands/subscriptions/<social>/`,
 * wired onto this command by `@wolfstar/plugin-subcommands-advanced`.
 *
 * The autocomplete stays on the parent: the plugin routes `chatInputRun` to the children, but
 * autocomplete interactions are dispatched by top-level command name and never reach them.
 */
@RegisterCommand((builder) =>
	applyLocalizedBuilder(
		builder,
		"commands/subscriptions:name",
		"commands/subscriptions:description",
	)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
		.setContexts(InteractionContextType.Guild)
		.addSubcommandGroup((group) =>
			applyLocalizedBuilder(
				group,
				"commands/twitch:name",
				"commands/twitch:description",
			),
		)
		.addSubcommandGroup((group) =>
			applyLocalizedBuilder(
				group,
				"commands/subscriptions:groupRssName",
				"commands/subscriptions:groupRssDescription",
			),
		)
		.addSubcommandGroup((group) =>
			applyLocalizedBuilder(
				group,
				"commands/subscriptions:groupRedditName",
				"commands/subscriptions:groupRedditDescription",
			),
		)
		.addSubcommandGroup((group) =>
			applyLocalizedBuilder(
				group,
				"commands/subscriptions:groupBlueskyName",
				"commands/subscriptions:groupBlueskyDescription",
			),
		)
		.addSubcommandGroup((group) =>
			applyLocalizedBuilder(
				group,
				"commands/subscriptions:groupMastodonName",
				"commands/subscriptions:groupMastodonDescription",
			),
		)
		.addSubcommandGroup((group) =>
			applyLocalizedBuilder(
				group,
				"commands/subscriptions:groupYoutubeName",
				"commands/subscriptions:groupYoutubeDescription",
			),
		)
		.addSubcommandGroup((group) =>
			applyLocalizedBuilder(
				group,
				"commands/subscriptions:groupXName",
				"commands/subscriptions:groupXDescription",
			),
		)
		.addSubcommandGroup((group) =>
			applyLocalizedBuilder(
				group,
				"commands/subscriptions:groupInstagramName",
				"commands/subscriptions:groupInstagramDescription",
			),
		)
		.addSubcommandGroup((group) =>
			applyLocalizedBuilder(
				group,
				"commands/subscriptions:groupTiktokName",
				"commands/subscriptions:groupTiktokDescription",
			),
		),
)
export class UserCommand extends Subcommand {
	public override async autocompleteRun(
		interaction: Command.AutocompleteInteraction,
		args: Command.AutocompleteArguments<{ streamer: string; source: string }>,
	) {
		if (args.focused === "source") {
			return this.#autocompleteSource(interaction, args.source ?? "");
		}

		if (args.focused !== "streamer") return interaction.replyEmpty();

		const query = args.streamer ?? "";
		if (!query.length) return interaction.replyEmpty();

		const result = await getRequest<
			TwitchHelixResponse<TwitchChannelSearchResult>
		>(`search/channels?query=${encodeURIComponent(query)}&first=25`);
		if (result.isErr()) return interaction.replyEmpty();

		const { data } = result.unwrap();
		return interaction.reply({
			choices: data.map((channel) => ({
				name: channel.display_name,
				value: channel.broadcaster_login,
			})),
		});
	}

	async #autocompleteSource(
		interaction: Command.AutocompleteInteraction,
		query: string,
	) {
		if (!interaction.guildId) return interaction.replyEmpty();

		const result = await getGuildSocialSubscriptions(
			BigInt(interaction.guildId),
		);
		if (result.isErr()) return interaction.replyEmpty();

		const needle = query.toLowerCase();
		const sources = new Map(
			result
				.unwrap()
				.filter(
					({ source }) =>
						getSubscriptionProviders(interaction).includes(source.provider) &&
						source.displayName.toLowerCase().includes(needle),
				)
				.map(({ source }) => [source.id, source]),
		);

		return interaction.reply({
			choices: [...sources.values()].slice(0, 25).map((source) => ({
				name: cutText(`${source.provider}: ${source.displayName}`, 100),
				value: String(source.id),
			})),
		});
	}
}
