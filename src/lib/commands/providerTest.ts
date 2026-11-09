import type {
	SocialSubscriptionOptions,
	TestSocialSubscriptionError,
} from "#social/subscriptions";
import type { TwitchEvent } from "#utils/subscriptionProviders";
import type { SlashCommandSubcommandBuilder } from "@discordjs/builders";
import {
	createSourceOption,
	getGuildSocialSubscriptions,
	parseSourceId,
	testSocialSubscription,
} from "#social/subscriptions";
import { createChannelOption, DeliveryErrorKeys } from "#twitch/subscriptions";
import { getSubscriptionProviders } from "#utils/subscriptionProviders";
import { channelMention } from "@discordjs/formatters";
import {
	applyLocalizedBuilder,
	getSupportedLanguageT as resolveKey,
} from "@wolfstar/plugin-i18next";
import { Command } from "@wolfstar/plugin-subcommands-advanced";
import { MessageFlags } from "discord-api-types/v10";

const TestErrorKeys = {
	...DeliveryErrorKeys,
	providerNotConfigured: "commands/social:addProviderNotConfigured",
	targetUnreachable: "commands/social:addTargetUnreachable",
	noItems: "commands/social:testNoItems",
} as const;

export const buildProviderTestCommand = (
	builder: SlashCommandSubcommandBuilder,
) =>
	applyLocalizedBuilder(
		builder,
		"commands/social:testName",
		"commands/social:testDescription",
	)
		.addStringOption(createSourceOption())
		.addChannelOption(createChannelOption().setRequired(true));

export class ProviderTestCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: SocialSubscriptionOptions & { event?: TwitchEvent },
		reply?: Awaited<ReturnType<Command.ChatInputInteraction["defer"]>>,
	) {
		const deferred =
			reply ?? (await interaction.defer({ flags: MessageFlags.Ephemeral }));
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
			.filter((entry) =>
				getSubscriptionProviders(interaction, options.event).includes(
					entry.source.provider,
				),
			)
			.find(
				(entry) => entry.sourceId === sourceId && entry.channelId === channelId,
			);
		if (!subscription) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/social:subscriptionNotFound",
					{ REDCROSS: "❌", channel },
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
					REDCROSS: "❌",
					channel,
				}),
			});
		}

		return deferred.update({
			content: await resolveKey(interaction, "commands/twitch:testSuccess", {
				GREENTICK: "✅",
				channel,
			}),
		});
	}
}
