import type { TwitchEventOptions } from "#utils/twitchCommandOptions";
import type { Command } from "@wolfstar/http-framework";
import { ProviderAddCommand } from "#lib/commands/providerAdd";
import { ProviderRemoveCommand } from "#lib/commands/providerRemove";
import { ProviderTestCommand } from "#lib/commands/providerTest";
import { getGuildSocialSubscriptions } from "#social/subscriptions";
import { getStreamer } from "#twitch/subscriptions";
import { getSubscriptionProviders } from "#utils/subscriptionProviders";
import { getSupportedLanguageT as resolveKey } from "@wolfstar/plugin-i18next";
import { MessageFlags } from "discord-api-types/v10";

/** Videos and clips share the social services, but members address them by Twitch streamer. */
export async function runTwitchMediaAction(
	command: Command,
	interaction: Command.ChatInputInteraction,
	options: TwitchEventOptions,
	action: "add" | "remove" | "test",
) {
	if (action === "add")
		return ProviderAddCommand.prototype.chatInputRun.call(
			command,
			interaction,
			{
				...options,
				target: options.streamer,
				message: options.message ?? undefined,
			},
		);
	const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
	const streamer = await getStreamer(options.streamer);
	if (!streamer)
		return deferred.update({
			content: await resolveKey(
				interaction,
				"commands/twitch:streamerNotFound",
			),
		});
	const loaded = await getGuildSocialSubscriptions(
		BigInt(interaction.guildId!),
	);
	if (loaded.isErr()) {
		command.container.logger.error(
			"[subscriptions] Failed to resolve Twitch media subscription",
			loaded.unwrapErr(),
		);
		return deferred.update({
			content: await resolveKey(interaction, "commands/twitch:testFailed"),
		});
	}
	const subscription = loaded
		.unwrap()
		.find(
			(entry) =>
				getSubscriptionProviders(interaction, options.event).includes(
					entry.source.provider,
				) &&
				entry.source.target === streamer.id &&
				entry.channelId === BigInt(options.channel.id),
		);
	if (!subscription)
		return deferred.update({
			content: await resolveKey(interaction, "commands/social:sourceNotFound"),
		});
	const args = {
		source: String(subscription.sourceId),
		channel: options.channel,
		event: options.event,
	};
	return action === "remove"
		? ProviderRemoveCommand.prototype.chatInputRun.call(
				command,
				interaction,
				args,
				deferred,
			)
		: ProviderTestCommand.prototype.chatInputRun.call(
				command,
				interaction,
				args,
				deferred,
			);
}
