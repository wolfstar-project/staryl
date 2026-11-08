import type { SocialAddOptions } from "#social/subscriptions";
import { DefaultSocialFilters, parseKeywordList } from "#social/filters";
import { escapeInlineText } from "#social/notifications";
import {
	addSocialSubscription,
	MaximumXAccountsPerGuild,
	createProviderOption,
	SocialGroupName,
} from "#social/subscriptions";
import {
	createChannelOption,
	MaximumMessageLength,
	SubscriptionsCommandName,
} from "#twitch/subscriptions";
import { channelMention } from "@discordjs/formatters";
import {
	applyLocalizedBuilder,
	createSelectMenuChoiceName,
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
			"commands/social:addName",
			"commands/social:addDescription",
		)
			.addStringOption(createProviderOption())
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/social:optionsTargetName",
					"commands/social:optionsTargetDescription",
				)
					.setMaxLength(500)
					.setRequired(true),
			)
			.addChannelOption(createChannelOption().setRequired(true))
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/social:optionsMessageName",
					"commands/social:optionsMessageDescription",
				).setMaxLength(MaximumMessageLength),
			)
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
			)
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/social:optionsFlairsName",
					"commands/social:optionsFlairsDescription",
				).setMaxLength(500),
			)
			.addIntegerOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/social:optionsMinimumScoreName",
					"commands/social:optionsMinimumScoreDescription",
				).setMinValue(1),
			)
			.addBooleanOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/social:optionsExcludeRepliesName",
					"commands/social:optionsExcludeRepliesDescription",
				),
			)
			.addBooleanOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/social:optionsExcludeRepostsName",
					"commands/social:optionsExcludeRepostsDescription",
				),
			)
			.addStringOption((option) =>
				applyLocalizedBuilder(
					option,
					"commands/social:optionsShortsName",
					"commands/social:optionsShortsDescription",
				).addChoices(
					createSelectMenuChoiceName(
						"commands/social:optionsShortsChoiceInclude",
						{ value: "include" },
					),
					createSelectMenuChoiceName(
						"commands/social:optionsShortsChoiceExclude",
						{ value: "exclude" },
					),
					createSelectMenuChoiceName(
						"commands/social:optionsShortsChoiceOnly",
						{ value: "only" },
					),
				),
			),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: SocialAddOptions,
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });

		const result = await addSocialSubscription({
			guildId: BigInt(interaction.guildId!),
			channelId: BigInt(options.channel.id),
			providerName: options.provider,
			input: options.target,
			message: options.message ?? null,
			filters: {
				...DefaultSocialFilters,
				includeKeywords: parseKeywordList(options.keywords),
				excludeKeywords: parseKeywordList(options.exclude_keywords),
				flairs: parseKeywordList(options.flairs),
				minimumScore: options.minimum_score ?? null,
				excludeReplies: options.exclude_replies ?? false,
				excludeReposts: options.exclude_reposts ?? false,
				shorts: options.shorts ?? "include",
			},
		});

		if (result.isErr()) {
			const error = result.unwrapErr();
			return deferred.update({
				content:
					error === "commands/social:addXLimitReached"
						? await resolveKey(interaction, error, {
								maximum: MaximumXAccountsPerGuild,
							})
						: await resolveKey(interaction, error),
			});
		}

		const content = await resolveKey(
			interaction,
			"commands/social:addSuccess",
			{
				name: escapeInlineText(result.unwrap().displayName),
				channel: channelMention(options.channel.id),
			},
		);
		return deferred.update({ content });
	}
}
