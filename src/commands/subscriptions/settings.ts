import type { AnyNamespace, TFunction } from "@wolfstar/plugin-i18next";
import { getSettingsSubscriptionCount } from "#utils/settingsCounts";
import {
	buildSettingsMenu,
	SettingsInteractionHandlerName,
} from "#utils/settingsMenu";
import { cast } from "@sapphire/utilities";
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
		"commands/settings:name",
		"commands/settings:description",
	)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
		.setContexts(InteractionContextType.Guild),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
	) {
		if (!interaction.inGuild()) return;

		// Acknowledge before the count query: Discord's response window is short enough that waiting
		// on the database first can make it expire, answering with an unknown-interaction error
		// instead of the menu.
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });

		const t = cast<TFunction<AnyNamespace>>(getSupportedLanguageT(interaction));
		const subscriptionCountResult = await getSettingsSubscriptionCount(
			BigInt(interaction.guildId),
		);
		if (subscriptionCountResult.isErr()) {
			this.container.logger.error(
				`[${SettingsInteractionHandlerName}] Failed to read subscriptions for guild ${interaction.guildId}`,
				subscriptionCountResult.unwrapErr(),
			);
		}

		const menu = buildSettingsMenu(
			{
				page: "overview",
				// A failed count still needs a number to render, but must not read as "no
				// notifications configured" — the notice makes the failure visible instead of
				// silently showing zero.
				subscriptionCount: subscriptionCountResult.unwrapOr(0),
				userId: interaction.user.id,
				notice: subscriptionCountResult.isErr()
					? cast<string>(t("commands/twitch:testFailed"))
					: undefined,
			},
			t,
		);
		return deferred.update(menu);
	}
}
