import {
	getGuildSocialSubscriptions,
	resetGuildSocialSubscriptions,
	SocialGroupName,
} from "#social/subscriptions";
import { SubscriptionsCommandName } from "#twitch/subscriptions";
import {
	applyLocalizedBuilder,
	getSupportedLanguageT as resolveKey,
} from "@wolfstar/plugin-i18next";
import {
	Command,
	RegisterAsSubcommandGroup,
} from "@wolfstar/plugin-subcommands-advanced";
import { MessageFlags } from "discord-api-types/v10";

@RegisterAsSubcommandGroup(
	SubscriptionsCommandName,
	SocialGroupName,
	(builder) =>
		applyLocalizedBuilder(
			builder,
			"commands/social:resetName",
			"commands/social:resetDescription",
		),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });

		const subscriptionsResult = await getGuildSocialSubscriptions(
			BigInt(interaction.guildId!),
		);
		if (subscriptionsResult.isErr()) {
			this.container.logger.error(
				"[social-subscriptions] Failed to read the guild subscriptions",
				subscriptionsResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, "commands/social:resetFailed"),
			});
		}

		const subscriptions = subscriptionsResult.unwrap();
		if (subscriptions.length === 0) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/social:noSubscriptions",
				),
			});
		}

		const removal = await resetGuildSocialSubscriptions(subscriptions);
		if (removal.isErr()) {
			this.container.logger.error(
				"[social-subscriptions] Failed to remove the guild subscriptions",
				removal.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, "commands/social:resetFailed"),
			});
		}

		const content = await resolveKey(
			interaction,
			"commands/social:resetSuccess",
			{ count: subscriptions.length },
		);
		return deferred.update({ content });
	}
}
