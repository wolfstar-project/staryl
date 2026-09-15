import {
	buildClosedSetupMenu,
	buildSetupMenu,
	isSetupPage,
} from "#utils/setupMenu";
import { Result } from "@sapphire/result";
import { cast } from "@sapphire/utilities";
import { InteractionHandler } from "@wolfstar/http-framework";
import { getSupportedLanguageT } from "@wolfstar/plugin-i18next";
import { ComponentType, MessageFlags } from "discord-api-types/v10";

export class UserInteractionHandler extends InteractionHandler {
	public override async run(
		interaction: InteractionHandler.Interaction,
		customIdValue: unknown,
	) {
		const t = getSupportedLanguageT(interaction);
		const customIdParts = Array.isArray(customIdValue) ? customIdValue : [];
		const [ownerId, action] = customIdParts;
		if (typeof ownerId !== "string" || typeof action !== "string") {
			return interaction.reply({
				content: t("commands/setup:errors.invalid"),
				flags: MessageFlags.Ephemeral,
			});
		}

		if (interaction.user.id !== ownerId) {
			return interaction.reply({
				content: t("commands/setup:errors.ownerOnly"),
				flags: MessageFlags.Ephemeral,
			});
		}

		if (action === "close") return interaction.update(buildClosedSetupMenu(t));
		if (
			action !== "navigate" ||
			interaction.data.component_type !== ComponentType.StringSelect
		) {
			return interaction.reply({
				content: t("commands/setup:errors.actionUnavailable"),
				flags: MessageFlags.Ephemeral,
			});
		}

		const page =
			cast<InteractionHandler.SelectMenuInteraction>(interaction).values[0];
		if (page === undefined || !isSetupPage(page)) {
			return interaction.reply({
				content: t("commands/setup:errors.sectionUnavailable"),
				flags: MessageFlags.Ephemeral,
			});
		}

		const subscriptionCount = await this.#getSubscriptionCount(interaction);
		return interaction.update(
			buildSetupMenu({ page, subscriptionCount, userId: ownerId }, t),
		);
	}

	async #getSubscriptionCount(
		interaction: InteractionHandler.Interaction,
	): Promise<number> {
		if (!interaction.inGuild()) return 0;

		const result = await Result.fromAsync(() =>
			this.container.prisma.guildSubscription.count({
				where: { guildId: BigInt(interaction.guildId) },
			}),
		);
		if (result.isErr()) {
			this.container.logger.error(
				`[setup] Failed to refresh subscriptions for guild ${interaction.guildId}`,
				result.unwrapErr(),
			);
		}

		return result.unwrapOr(0);
	}
}
