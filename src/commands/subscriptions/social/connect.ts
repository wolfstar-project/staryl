import type { APIChannel } from "discord-api-types/v10";
import { beginSocialConnection } from "#social/connectedAccounts";
import { DefaultSocialFilters, parseKeywordList } from "#social/filters";
import { createInstagramApi } from "#social/providers/instagram";
import { SocialGroupName } from "#social/subscriptions";
import {
	createChannelOption,
	SubscriptionsCommandName,
} from "#twitch/subscriptions";
import { Result } from "@sapphire/result";
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
			"commands/social:connectName",
			"commands/social:connectDescription",
		)
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/social:optionsProviderName",
					"commands/social:optionsProviderDescription",
				)
					.setRequired(true)
					.addChoices({ name: "Instagram", value: "Instagram" }),
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
			),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: {
			provider: "Instagram";
			channel: APIChannel;
			keywords?: string;
			exclude_keywords?: string;
		},
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		const result = await Result.fromAsync(() =>
			beginSocialConnection(
				createInstagramApi(),
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
		const started = result.unwrapOr(null);
		return deferred.update({
			content: started?.isOk()
				? await resolveKey(interaction, "commands/social:connectLink", {
						url: started.unwrap(),
					})
				: await resolveKey(
						interaction,
						started?.isErr() && started.unwrapErr() === "Denied"
							? "commands/social:connectDenied"
							: "commands/social:connectFailed",
					),
		});
	}
}
