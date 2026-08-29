import type { TwitchChannelSearchResult } from "#utils/twitchSubscriptions";
import type { TwitchHelixResponse } from "@wolfstar/twitch-helpers";
import { LanguageKeys } from "#i18n";
import { Command, RegisterCommand } from "@wolfstar/http-framework";
import { applyLocalizedBuilder } from "@wolfstar/plugin-i18next";
import { Subcommand } from "@wolfstar/plugin-subcommands-advanced";
import { getRequest } from "@wolfstar/twitch-helpers";
import {
	ApplicationIntegrationType,
	InteractionContextType,
	PermissionFlagsBits,
} from "discord-api-types/v10";

const Root = LanguageKeys.Commands.Subscriptions;
const Twitch = LanguageKeys.Commands.Twitch;

/**
 * The parent of every subscription subcommand. Each social network owns a subcommand group declared
 * here, and its subcommands live in their own classes under `commands/subscriptions/<social>/`,
 * wired onto this command by `@wolfstar/plugin-subcommands-advanced`.
 *
 * The autocomplete stays on the parent: the plugin routes `chatInputRun` to the children, but
 * autocomplete interactions are dispatched by top-level command name and never reach them.
 */
@RegisterCommand((builder) =>
	applyLocalizedBuilder(builder, Root.RootName, Root.RootDescription)
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
		.setContexts(InteractionContextType.Guild)
		.addSubcommandGroup((group) =>
			applyLocalizedBuilder(group, Twitch.RootName, Twitch.RootDescription),
		),
)
export class UserCommand extends Subcommand {
	public override async autocompleteRun(
		interaction: Command.AutocompleteInteraction,
		args: Command.AutocompleteArguments<{ streamer: string }>,
	) {
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
}
