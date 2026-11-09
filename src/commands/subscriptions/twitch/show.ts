import type { TwitchListOptions } from "#utils/twitchSubscriptionCommands";
import {
	createStreamerOption,
	SubscriptionsCommandName,
	TwitchGroupName,
} from "#twitch/subscriptions";
import { createTwitchEventOption } from "#utils/twitchCommandOptions";
import { runTwitchListCommand } from "#utils/twitchSubscriptionCommands";
import { applyLocalizedBuilder } from "@wolfstar/plugin-i18next";
import {
	Command,
	RegisterAsSubcommandGroup,
} from "@wolfstar/plugin-subcommands-advanced";

@RegisterAsSubcommandGroup(
	SubscriptionsCommandName,
	TwitchGroupName,
	(builder) =>
		applyLocalizedBuilder(
			builder,
			"commands/twitch:showName",
			"commands/twitch:showDescription",
		)
			.addStringOption(createStreamerOption(false))
			.addStringOption(createTwitchEventOption(false)),
)
export class UserCommand extends Command {
	public override chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: TwitchListOptions,
	) {
		return runTwitchListCommand(interaction, options, "show");
	}
}
