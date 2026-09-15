import { buildSetupMenu, SetupInteractionHandlerName } from "#utils/setupMenu";
import { Result } from "@sapphire/result";
import { Command, RegisterCommand } from "@wolfstar/http-framework";
import {
	applyLocalizedBuilder,
	getSupportedLanguageT,
} from "@wolfstar/plugin-i18next";
import {
	ApplicationIntegrationType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
} from "discord-api-types/v10";

@RegisterCommand((builder) =>
	applyLocalizedBuilder(
		builder,
		"commands/setup:name",
		"commands/setup:description",
	)
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
		.setContexts(InteractionContextType.Guild),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
	) {
		if (!interaction.inGuild()) return;

		const subscriptionCountResult = await Result.fromAsync(() =>
			this.container.prisma.guildSubscription.count({
				where: { guildId: BigInt(interaction.guildId) },
			}),
		);
		if (subscriptionCountResult.isErr()) {
			this.container.logger.error(
				`[${SetupInteractionHandlerName}] Failed to read subscriptions for guild ${interaction.guildId}`,
				subscriptionCountResult.unwrapErr(),
			);
		}

		const menu = buildSetupMenu(
			{
				page: "overview",
				subscriptionCount: subscriptionCountResult.unwrapOr(0),
				userId: interaction.user.id,
			},
			getSupportedLanguageT(interaction),
		);
		return interaction.reply({
			...menu,
			flags: menu.flags | MessageFlags.Ephemeral,
		});
	}
}
