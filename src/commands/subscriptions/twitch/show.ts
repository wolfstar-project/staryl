import type { TwitchStreamerFilterOptions } from "#utils/twitchSubscriptions";
import {
	createStreamerOption,
	fetchStreamerNames,
	getGuildSubscriptions,
	getStreamer,
	getSubscriptionStatus,
	SubscriptionsCommandName,
	TwitchGroupName,
} from "#utils/twitchSubscriptions";
import { EmbedBuilder } from "@discordjs/builders";
import { channelMention } from "@discordjs/formatters";
import { isNullish } from "@sapphire/utilities";
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
			"commands/twitch:showName",
			"commands/twitch:showDescription",
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
				content: await resolveKey(
					interaction,
					"commands/twitch:noSubscriptions",
				),
			});
		}

		const allSubscriptions = guildSubscriptionsResult.unwrap();

		if (!allSubscriptions.length) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/twitch:noSubscriptions",
				),
			});
		}

		let streamerFilter: { id: string; display_name: string } | null = null;
		if (!isNullish(options.streamer)) {
			streamerFilter = await getStreamer(options.streamer);
			if (isNullish(streamerFilter)) {
				return deferred.update({
					content: await resolveKey(
						interaction,
						"commands/twitch:streamerNotFound",
					),
				});
			}
		}

		const subscriptions = streamerFilter
			? allSubscriptions.filter(
					(gs) => gs.twitchSubscription.streamerId === streamerFilter!.id,
				)
			: allSubscriptions;

		if (!subscriptions.length) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/twitch:showStreamerNotSubscribed",
				),
			});
		}

		const [statuses, unknownUser] = await Promise.all([
			resolveKey(interaction, "commands/twitch:showStatus"),
			resolveKey(interaction, "commands/twitch:showUnknownUser"),
		]);

		const names = streamerFilter
			? new Map([[streamerFilter.id, streamerFilter.display_name]])
			: await fetchStreamerNames(
					subscriptions.map((gs) => gs.twitchSubscription.streamerId),
				);

		const lines = subscriptions.map((gs) => {
			const name = names.get(gs.twitchSubscription.streamerId) ?? unknownUser;
			const status = getSubscriptionStatus(
				gs.twitchSubscription.subscriptionType,
				statuses,
			);
			return `${name} — ${channelMention(String(gs.channelId))} → ${status}`;
		});

		const embed = new EmbedBuilder()
			.setTitle(await resolveKey(interaction, "commands/twitch:showEmbedTitle"))
			.setDescription(lines.join("\n"));
		return deferred.update({ embeds: [embed.toJSON()] });
	}
}
