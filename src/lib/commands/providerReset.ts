import type { TwitchEvent } from "#utils/subscriptionProviders";
import type { SlashCommandSubcommandBuilder } from "@discordjs/builders";
import {
	getGuildSocialSubscriptions,
	resetGuildSocialSubscriptions,
} from "#social/subscriptions";
import { getSubscriptionProviders } from "#utils/subscriptionProviders";
import {
	applyLocalizedBuilder,
	getSupportedLanguageT as resolveKey,
} from "@wolfstar/plugin-i18next";
import { Command } from "@wolfstar/plugin-subcommands-advanced";
import { MessageFlags } from "discord-api-types/v10";

export const buildProviderResetCommand = (
	builder: SlashCommandSubcommandBuilder,
) =>
	applyLocalizedBuilder(
		builder,
		"commands/social:resetName",
		"commands/social:resetDescription",
	);

export class ProviderResetCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: { event?: TwitchEvent } = {},
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

		const subscriptions = subscriptionsResult
			.unwrap()
			.filter((entry) =>
				getSubscriptionProviders(interaction, options.event).includes(
					entry.source.provider,
				),
			);
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
