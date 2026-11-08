import type { APIEmbed } from "discord-api-types/v10";
import { escapeInlineText } from "#social/notifications";
import { getSocialProvider } from "#social/registry";
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
					`commands/social:health.${getSocialProvider(source.provider)?.getAuthRequirements().satisfied ? describeSourceHealth(source) : "unavailable"}`,
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
		const pages = splitEmbedMessages(embeds);
		const initialReply = await deferred.update({ embeds: pages[0]! });
		for (const page of pages.slice(1)) {
			// oxlint-disable-next-line no-await-in-loop -- preserve the subscription order in private follow-ups
			const sent = await interaction.followup({
				embeds: page,
				flags: MessageFlags.Ephemeral,
			});
			sent.inspectErr((error) =>
				this.container.logger.error(
					"[social-subscriptions] Failed to send another subscription page",
					error,
				),
			);
		}
		return initialReply;
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

/** Discord counts text across all embeds in one message, not just each description. */
function splitEmbedMessages(embeds: APIEmbed[]) {
	const pages: APIEmbed[][] = [];
	let current: APIEmbed[] = [];
	let length = 0;
	for (const embed of embeds) {
		const size = (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
		if (current.length === 10 || length + size > 6000) {
			pages.push(current);
			current = [];
			length = 0;
		}
		current.push(embed);
		length += size;
	}
	if (current.length) pages.push(current);
	return pages;
}
