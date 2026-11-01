import type { SocialAddOptions } from "#social/subscriptions";
import { DefaultSocialFilters, parseKeywordList } from "#social/filters";
import {
	addSocialSubscription,
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
			},
		});

		if (result.isErr()) {
			return deferred.update({
				content: await resolveKey(interaction, result.unwrapErr()),
			});
		}

		const content = await resolveKey(
			interaction,
			"commands/social:addSuccess",
			{
				name: result.unwrap().displayName,
				channel: channelMention(options.channel.id),
			},
		);
		return deferred.update({ content });
	}
}
