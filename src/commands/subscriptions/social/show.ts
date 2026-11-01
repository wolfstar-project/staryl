import { escapeInlineText } from "#social/notifications";
import { describeSourceHealth } from "#social/schedule";
import {
	getGuildSocialSubscriptions,
	SocialGroupName,
} from "#social/subscriptions";
import { SubscriptionsCommandName } from "#twitch/subscriptions";
import { EmbedBuilder } from "@discordjs/builders";
import { channelMention } from "@discordjs/formatters";
import { cutText } from "@sapphire/utilities";
import {
	applyLocalizedBuilder,
	getSupportedLanguageT as resolveKey,
} from "@wolfstar/plugin-i18next";
import {
	Command,
	RegisterAsSubcommandGroup,
} from "@wolfstar/plugin-subcommands-advanced";
import { MessageFlags } from "discord-api-types/v10";

/** A server can list 25 of these, and a message holds 6000 characters across its embeds. */
const MaximumShownNameLength = 64;
const MaximumEmbedDescriptionLength = 4096;

@RegisterAsSubcommandGroup(
	SubscriptionsCommandName,
	SocialGroupName,
	(builder) =>
		applyLocalizedBuilder(
			builder,
			"commands/social:showName",
			"commands/social:showDescription",
		),
)
export class UserCommand extends Command {
	public override async chatInputRun(
		interaction: Command.ChatInputInteraction,
	) {
		const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });

		const subscriptionsResult = await getGuildSocialSubscriptions(
			BigInt(interaction.guildId!),
		);
		if (subscriptionsResult.isErr()) {
			this.container.logger.error(
				"[social-subscriptions] Failed to read the guild subscriptions",
				subscriptionsResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, "commands/social:showFailed"),
			});
		}

		const subscriptions = subscriptionsResult.unwrap();
		if (subscriptions.length === 0) {
			return deferred.update({
				content: await resolveKey(
					interaction,
					"commands/social:noSubscriptions",
				),
			});
		}

		const lines = await Promise.all(
			subscriptions.map(async ({ source, channelId, deliveryError }) => {
				const health = await resolveKey(
					interaction,
					`commands/social:health.${describeSourceHealth(source)}`,
				);
				const delivery = deliveryError
					? `\n-# ${await resolveKey(interaction, `commands/social:deliveryErrors.${deliveryError}`)}`
					: "";
				const provider = await resolveKey(
					interaction,
					`commands/social:provider${source.provider}`,
				);
				// Escaped first, so a name full of markdown cannot double past the limit.
				const name = cutText(
					escapeInlineText(source.displayName),
					MaximumShownNameLength,
				);
				return `**${name}** (${provider}) — ${channelMention(String(channelId))} → ${health}${delivery}`;
			}),
		);

		const title = await resolveKey(
			interaction,
			"commands/social:showEmbedTitle",
		);
		const embeds = splitDescriptions(lines).map((description, index) =>
			(index === 0 ? new EmbedBuilder().setTitle(title) : new EmbedBuilder())
				.setDescription(description)
				.toJSON(),
		);
		return deferred.update({ embeds });
	}
}

/** A full server does not fit one description, and nothing it follows may be left out. */
function splitDescriptions(lines: readonly string[]) {
	const descriptions: string[] = [];
	let current = "";
	for (const line of lines) {
		if (current.length + line.length + 1 > MaximumEmbedDescriptionLength) {
			descriptions.push(current);
			current = line;
		} else {
			current = current ? `${current}\n${line}` : line;
		}
	}

	descriptions.push(current);
	return descriptions;
}
