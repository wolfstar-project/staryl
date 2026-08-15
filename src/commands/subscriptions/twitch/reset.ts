import type { TwitchStreamerFilterOptions } from "#utils/twitchSubscriptions";
import { LanguageKeys } from "#i18n";
import {
	createStreamerOption,
	deleteSubscription,
	getGuildSubscriptions,
	getStreamer,
	removeSubscription,
	SubscriptionsCommandName,
	TwitchGroupName,
} from "#utils/twitchSubscriptions";
import { Result } from "@sapphire/result";
import { cast, isNullish } from "@sapphire/utilities";
import {
	applyLocalizedBuilder,
	resolveKey,
} from "@wolfstar/http-framework-i18n";
import {
	Command,
	RegisterAsSubcommandGroup,
} from "@wolfstar/plugin-subcommands-advanced";
import { MessageFlags } from "discord-api-types/v10";

const Root = LanguageKeys.Commands.Twitch;

@RegisterAsSubcommandGroup(
	SubscriptionsCommandName,
	TwitchGroupName,
	(builder) =>
		applyLocalizedBuilder(
			builder,
			Root.ResetName,
			Root.ResetDescription,
		).addStringOption(createStreamerOption(false)),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
		options: TwitchStreamerFilterOptions,
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
		const guildId = BigInt(interaction.guildId!);

		const guildSubscriptionsResult = await getGuildSubscriptions(guildId);
		if (guildSubscriptionsResult.isErr()) {
			this.container.logger.error(
				"[twitch-subscriptions] Failed to read the guild subscriptions",
				guildSubscriptionsResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, Root.ResetFailed),
			});
		}

		let guildSubscriptions = guildSubscriptionsResult.unwrap();

		if (!guildSubscriptions.length) {
			return deferred.update({
				content: await resolveKey(interaction, Root.NoSubscriptions),
			});
		}

		if (!isNullish(options.streamer)) {
			const streamer = await getStreamer(options.streamer);
			if (isNullish(streamer)) {
				return deferred.update({
					content: await resolveKey(interaction, Root.StreamerNotFound),
				});
			}
			guildSubscriptions = guildSubscriptions.filter(
				(gs) => gs.twitchSubscription.streamerId === streamer.id,
			);
		}

		if (!guildSubscriptions.length) {
			return deferred.update({
				content: await resolveKey(interaction, Root.NoSubscriptions),
			});
		}

		const count = guildSubscriptions.length;
		const uniqueSubscriptionIds = [
			...new Set(guildSubscriptions.map((gs) => gs.subscriptionId)),
		];

		const removalResult = await Result.fromAsync(async () => {
			await Promise.all(guildSubscriptions.map((gs) => deleteSubscription(gs)));
			await Promise.all(
				uniqueSubscriptionIds.map((subscriptionId) =>
					removeSubscription(subscriptionId),
				),
			);
		});
		if (removalResult.isErr()) {
			this.container.logger.error(
				"[twitch-subscriptions] Failed to reset the subscriptions",
				removalResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, Root.ResetFailed),
			});
		}

		const content = cast<string>(
			await resolveKey(interaction, Root.ResetSuccess, { count }),
		);
		return deferred.update({ content });
	}
}
