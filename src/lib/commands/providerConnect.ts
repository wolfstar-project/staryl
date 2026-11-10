import type { SlashCommandSubcommandBuilder } from "@discordjs/builders";
import type { APIChannel } from "discord-api-types/v10";
import { beginSocialConnection } from "#social/connectedAccounts";
import { DefaultSocialFilters, parseKeywordList } from "#social/filters";
import { createInstagramApi } from "#social/providers/instagram";
import { createTikTokApi } from "#social/providers/tiktok";
import { createChannelOption } from "#twitch/subscriptions";
import { getSubscriptionProviders } from "#utils/subscriptionProviders";
import { Result } from "@sapphire/result";
import {
	applyLocalizedBuilder,
	getSupportedLanguageT as resolveKey,
} from "@wolfstar/plugin-i18next";
import { Command } from "@wolfstar/plugin-subcommands-advanced";
import { MessageFlags } from "discord-api-types/v10";

export const buildProviderConnectCommand = (
	builder: SlashCommandSubcommandBuilder,
) =>
	applyLocalizedBuilder(
		builder,
		"commands/social:connectName",
		"commands/social:connectDescription",
	)
		.addChannelOption(createChannelOption().setRequired(true))
		.addStringOption((option) =>
			applyLocalizedBuilder(
				option,
				"commands/social:optionsKeywordsName",
				"commands/social:optionsKeywordsDescription",
			).setMaxLength(500),
		)
		.addStringOption((option) =>
			applyLocalizedBuilder(
				option,
				"commands/social:optionsExcludeKeywordsName",
				"commands/social:optionsExcludeKeywordsDescription",
			).setMaxLength(500),
		);

export class ProviderConnectCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: {
			channel: APIChannel;
			keywords?: string;
			exclude_keywords?: string;
		},
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		const result = await Result.fromAsync(() =>
			beginSocialConnection(
				getSubscriptionProviders(interaction)[0] === "TikTok"
					? createTikTokApi()
					: createInstagramApi(),
				BigInt(interaction.guildId!),
				BigInt(options.channel.id),
				interaction.user.id,
				{
					...DefaultSocialFilters,
					includeKeywords: parseKeywordList(options.keywords),
					excludeKeywords: parseKeywordList(options.exclude_keywords),
				},
			),
		);
		return deferred.update({
			content: result.isOk()
				? await resolveKey(interaction, "commands/social:connectLink", {
						url: result.unwrap(),
					})
				: await resolveKey(
						interaction,
						result.unwrapErr() === "Denied"
							? "commands/social:connectDenied"
							: "commands/social:connectFailed",
					),
		});
	}
}
