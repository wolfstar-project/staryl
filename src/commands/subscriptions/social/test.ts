import type {
	SocialSubscriptionOptions,
	TestSocialSubscriptionError,
} from "#social/subscriptions";
import {
	createSourceOption,
	getGuildSocialSubscriptions,
	parseSourceId,
	SocialGroupName,
	testSocialSubscription,
} from "#social/subscriptions";
import {
	createChannelOption,
	DeliveryErrorKeys,
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

const TestErrorKeys = {
	...DeliveryErrorKeys,
	providerNotConfigured: "commands/social:addProviderNotConfigured",
	targetUnreachable: "commands/social:addTargetUnreachable",
	noItems: "commands/social:testNoItems",
} as const;

@RegisterAsSubcommandGroup(
	SubscriptionsCommandName,
	SocialGroupName,
	(builder) =>
		applyLocalizedBuilder(
			builder,
			"commands/social:testName",
			"commands/social:testDescription",
		)
			.addStringOption(createSourceOption())
			.addChannelOption(createChannelOption().setRequired(true)),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: SocialSubscriptionOptions,
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		const channelId = BigInt(options.channel.id);
		const sourceId = parseSourceId(options.source);
		const channel = channelMention(options.channel.id);

		const subscriptionsResult = await getGuildSocialSubscriptions(
			BigInt(interaction.guildId!),
		);
		if (subscriptionsResult.isErr()) {
			this.container.logger.error(
				"[social-subscriptions] Failed to read the guild subscriptions",
				subscriptionsResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, "commands/twitch:testFailed"),
			});
		}

		const subscription = subscriptionsResult
			.unwrap()
			.find(
				(entry) => entry.sourceId === sourceId && entry.channelId === channelId,
			);
		if (!subscription) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/social:subscriptionNotFound",
					{ channel },
				),
			});
		}

		const result = await testSocialSubscription(
			subscription,
			await resolveKey(interaction, "events/social:testNotice"),
		);
		if (result.isErr()) {
			const error: TestSocialSubscriptionError = result.unwrapErr();
			return deferred.update({
				content: await resolveKey(interaction, TestErrorKeys[error], {
					channel,
				}),
			});
		}

		return deferred.update({
			content: await resolveKey(interaction, "commands/twitch:testSuccess", {
				channel,
			}),
		});
	}
}
