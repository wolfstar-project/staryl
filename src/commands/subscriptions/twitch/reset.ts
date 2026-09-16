import type { TwitchStreamerFilterOptions } from "#utils/twitch/subscriptions";
import {
	createStreamerOption,
	getGuildSubscriptions,
	getStreamer,
	resetGuildSubscriptions,
	SubscriptionsCommandName,
	TwitchGroupName,
} from "#utils/twitch/subscriptions";
import { cast, isNullish } from "@sapphire/utilities";
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
	TwitchGroupName,
	(builder) =>
		applyLocalizedBuilder(
			builder,
			"commands/twitch:resetName",
			"commands/twitch:resetDescription",
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
				content: await resolveKey(interaction, "commands/twitch:resetFailed"),
			});
		}

		let guildSubscriptions = guildSubscriptionsResult.unwrap();

		if (!guildSubscriptions.length) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/twitch:noSubscriptions",
				),
			});
		}

		if (!isNullish(options.streamer)) {
			const streamer = await getStreamer(options.streamer);
			if (isNullish(streamer)) {
				return deferred.update({
					content: await resolveKey(
						interaction,
						"commands/twitch:streamerNotFound",
					),
				});
			}
			guildSubscriptions = guildSubscriptions.filter(
				(gs) => gs.twitchSubscription.streamerId === streamer.id,
			);
		}

		if (!guildSubscriptions.length) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/twitch:noSubscriptions",
				),
			});
		}

		const count = guildSubscriptions.length;

		const removalResult = await resetGuildSubscriptions(guildSubscriptions);
		if (removalResult.isErr()) {
			this.container.logger.error(
				"[twitch-subscriptions] Failed to reset the subscriptions",
				removalResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, "commands/twitch:resetFailed"),
			});
		}

		const content = cast<string>(
			await resolveKey(interaction, "commands/twitch:resetSuccess", { count }),
		);
		return deferred.update({ content });
	}
}
