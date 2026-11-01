import type { SocialRemoveOptions } from "#social/subscriptions";
import {
	createSourceOption,
	getGuildSocialSubscriptions,
	parseSourceId,
	removeSocialSubscription,
	SocialGroupName,
} from "#social/subscriptions";
import {
	createChannelOption,
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
			"commands/social:removeName",
			"commands/social:removeDescription",
		)
			.addStringOption(createSourceOption())
			.addChannelOption(
				applyLocalizedBuilder(
					createChannelOption(),
					"commands/social:optionsRemoveChannelName",
					"commands/social:optionsRemoveChannelDescription",
				),
			),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: SocialRemoveOptions,
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		const guildId = BigInt(interaction.guildId!);
		const sourceId = parseSourceId(options.source);

		const subscriptionsResult = await getGuildSocialSubscriptions(guildId);
		if (subscriptionsResult.isErr()) {
			this.container.logger.error(
				"[social-subscriptions] Failed to read the guild subscriptions",
				subscriptionsResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, "commands/social:removeFailed"),
			});
		}

		// The channel is optional because a deleted one can no longer be picked, which would make its
		// subscription impossible to remove.
		const matches = subscriptionsResult
			.unwrap()
			.filter(
				(entry) =>
					entry.sourceId === sourceId &&
					(!options.channel || entry.channelId === BigInt(options.channel.id)),
			);
		if (matches.length !== 1) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					matches.length === 0
						? "commands/social:sourceNotFound"
						: "commands/social:removeChannelRequired",
				),
			});
		}

		const [subscription] = matches;
		const { channelId } = subscription;

		const removal = await removeSocialSubscription({
			guildId,
			channelId,
			sourceId: subscription.sourceId,
		});
		if (removal.isErr()) {
			this.container.logger.error(
				"[social-subscriptions] Failed to remove the subscription",
				removal.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, "commands/social:removeFailed"),
			});
		}

		const content = await resolveKey(
			interaction,
			"commands/social:removeSuccess",
			{
				name: subscription.source.displayName,
				channel: channelMention(String(channelId)),
			},
		);
		return deferred.update({ content });
	}
}
