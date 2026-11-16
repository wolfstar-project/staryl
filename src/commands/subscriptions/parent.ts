import { runSubscriptionAutocomplete } from "#utils/subscriptionAutocomplete";
import { SubscriptionGroups } from "#utils/subscriptionProviders";
import { Command, RegisterCommand } from "@wolfstar/http-framework";
import { applyLocalizedBuilder } from "@wolfstar/plugin-i18next";
import { Subcommand } from "@wolfstar/plugin-subcommands-advanced";
import {
	ApplicationIntegrationType,
	InteractionContextType,
	PermissionFlagsBits,
} from "discord-api-types/v10";

/**
 * The parent of every subscription subcommand. Each social network owns a subcommand group, listed
 * in `SubscriptionGroups`, and its subcommands live in their own classes under
 * `commands/subscriptions/`, wired onto this command by `@wolfstar/plugin-subcommands-advanced`.
 *
 * The autocomplete stays on the parent: the plugin routes `chatInputRun` to the children, but
 * autocomplete interactions are dispatched by top-level command name and never reach them.
 */
@RegisterCommand((builder) => {
	const command = applyLocalizedBuilder(
		builder,
		"commands/subscriptions:name",
		"commands/subscriptions:description",
	)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
		.setContexts(InteractionContextType.Guild);

	for (const { name, description } of SubscriptionGroups) {
		command.addSubcommandGroup((group) =>
			applyLocalizedBuilder(group, name, description),
		);
	}
	return command;
})
export class UserCommand extends Subcommand {
	public override autocompleteRun(
		interaction: Command.AutocompleteInteraction,
		args: Command.AutocompleteArguments<Record<string, string>>,
	) {
		const { focused } = args;
		if (!focused) return interaction.replyEmpty();

		return runSubscriptionAutocomplete(
			interaction,
			focused,
			args[focused] ?? "",
		);
	}
}
