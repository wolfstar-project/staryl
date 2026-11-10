import type { GuildSocialSubscriptionWithSource } from "#social/subscriptions";
import type { GuildSubscriptionWithTwitch } from "#twitch/subscriptions";
import type { TwitchEvent } from "#utils/subscriptionProviders";
import type { Command } from "@wolfstar/http-framework";
import { escapeInlineText } from "#social/notifications";
import { getSocialProvider } from "#social/registry";
import { describeSourceHealth } from "#social/schedule";
import {
	getGuildSocialSubscriptions,
	resetGuildSocialSubscriptions,
} from "#social/subscriptions";
import {
	fetchStreamerNames,
	getGuildSubscriptions,
	getStreamer,
	getSubscriptionStatus,
	resetGuildSubscriptions,
} from "#twitch/subscriptions";
import { getTwitchLiveType } from "#utils/twitchCommandOptions";
import { EmbedBuilder } from "@discordjs/builders";
import { channelMention } from "@discordjs/formatters";
import { err, ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { getSupportedLanguageT as resolveKey } from "@wolfstar/plugin-i18next";
import { MessageFlags } from "discord-api-types/v10";

export interface TwitchListOptions {
	streamer?: string;
	event?: TwitchEvent;
}

async function loadTwitchCommandSubscriptions(
	guildId: bigint,
	options: TwitchListOptions,
) {
	const live: GuildSubscriptionWithTwitch[] = [];
	const social: GuildSocialSubscriptionWithSource[] = [];
	if (
		!options.event ||
		options.event === "live" ||
		options.event === "offline"
	) {
		const loaded = await getGuildSubscriptions(guildId);
		if (loaded.isErr()) {
			container.logger.error(
				"[subscriptions] Failed to load Twitch subscriptions",
				loaded.unwrapErr(),
			);
			return err("database" as const);
		}
		live.push(
			...loaded
				.unwrap()
				.filter(
					(entry) =>
						!options.event ||
						entry.twitchSubscription.subscriptionType ===
							getTwitchLiveType(options.event),
				),
		);
	}
	if (!options.event || options.event === "video" || options.event === "clip") {
		const loaded = await getGuildSocialSubscriptions(guildId);
		if (loaded.isErr()) {
			container.logger.error(
				"[subscriptions] Failed to load Twitch media subscriptions",
				loaded.unwrapErr(),
			);
			return err("database" as const);
		}
		const providers =
			options.event === "video"
				? ["TwitchVideos"]
				: options.event === "clip"
					? ["TwitchClips"]
					: ["TwitchVideos", "TwitchClips"];
		social.push(
			...loaded
				.unwrap()
				.filter((entry) => providers.includes(entry.source.provider)),
		);
	}
	if (!options.streamer) return ok({ live, social });
	const streamer = await getStreamer(options.streamer);
	if (!streamer) return err("streamer" as const);
	return ok({
		live: live.filter(
			(entry) => entry.twitchSubscription.streamerId === streamer.id,
		),
		social: social.filter((entry) => entry.source.target === streamer.id),
	});
}

export async function runTwitchListCommand(
	interaction: Command.ChatInputInteraction,
	options: TwitchListOptions,
	action: "show" | "reset",
) {
	const deferred = await interaction.defer({ flags: MessageFlags.Ephemeral });
	const loaded = await loadTwitchCommandSubscriptions(
		BigInt(interaction.guildId!),
		options,
	);
	if (loaded.isErr())
		return deferred.update({
			content: await resolveKey(
				interaction,
				loaded.unwrapErr() === "streamer"
					? "commands/twitch:streamerNotFound"
					: action === "reset"
						? "commands/twitch:resetFailed"
						: "commands/twitch:testFailed",
			),
		});
	const { live, social } = loaded.unwrap();
	const count = live.length + social.length;
	if (!count)
		return deferred.update({
			content: await resolveKey(
				interaction,
				options.streamer && action === "show"
					? "commands/twitch:showStreamerNotSubscribed"
					: "commands/twitch:noSubscriptions",
			),
		});
	if (action === "reset") {
		// Load every requested group before removing anything; a failed read must never become a partial reset.
		const liveResult = await resetGuildSubscriptions(live);
		const socialResult = liveResult.isOk()
			? await resetGuildSocialSubscriptions(social)
			: liveResult;
		if (socialResult.isErr()) {
			container.logger.error(
				"[subscriptions] Failed to reset Twitch subscriptions",
				socialResult.unwrapErr(),
			);
			return deferred.update({
				content: await resolveKey(interaction, "commands/twitch:resetFailed"),
			});
		}
		return deferred.update({
			content: await resolveKey(interaction, "commands/twitch:resetSuccess", {
				GREENTICK: "✅",
				count,
			}),
		});
	}
	const names = await fetchStreamerNames(
		live.map((entry) => entry.twitchSubscription.streamerId),
	);
	const statuses = {
		live: await resolveKey(interaction, "commands/twitch:showStatus.live"),
		offline: await resolveKey(
			interaction,
			"commands/twitch:showStatus.offline",
		),
	};
	const unknown = await resolveKey(
		interaction,
		"commands/twitch:showUnknownUser",
	);
	const revoked = await resolveKey(interaction, "commands/twitch:showRevoked");
	const lines = live.map(
		(entry) =>
			`${escapeInlineText(names.get(entry.twitchSubscription.streamerId) ?? unknown)} — ${channelMention(String(entry.channelId))} → ${getSubscriptionStatus(entry.twitchSubscription.subscriptionType, statuses)}${entry.twitchSubscription.revokedReason ? `\n-# ${revoked}` : ""}`,
	);
	const socialLines = await Promise.all(
		social.map(async (entry) => {
			const event = entry.source.provider === "TwitchVideos" ? "video" : "clip";
			const healthKey = getSocialProvider(
				entry.source.provider,
			)?.getAuthRequirements().satisfied
				? describeSourceHealth(entry.source)
				: "unavailable";
			const [label, health, delivery] = await Promise.all([
				resolveKey(interaction, `commands/twitch:events.${event}`),
				resolveKey(interaction, `commands/social:health.${healthKey}`),
				entry.deliveryError
					? resolveKey(
							interaction,
							`commands/social:deliveryErrors.${entry.deliveryError}`,
						)
					: Promise.resolve(""),
			]);
			return `${escapeInlineText(entry.source.displayName)} — ${channelMention(String(entry.channelId))} → ${label} · ${health}${
				delivery
					? `
-# ${delivery}`
					: ""
			}`;
		}),
	);
	lines.push(...socialLines);
	const title = await resolveKey(interaction, "commands/twitch:showEmbedTitle");
	const pages: string[] = [];
	let page = "";
	for (const line of lines) {
		if (page.length + line.length + 1 > 4000) {
			pages.push(page);
			page = "";
		}
		page += `${page ? "\n" : ""}${line}`;
	}
	if (page) pages.push(page);
	const response = await deferred.update({
		embeds: [
			new EmbedBuilder().setTitle(title).setDescription(pages[0]!).toJSON(),
		],
	});
	for (const description of pages.slice(1)) {
		// oxlint-disable-next-line no-await-in-loop -- preserve page order
		const sent = await interaction.followup({
			embeds: [
				new EmbedBuilder().setTitle(title).setDescription(description).toJSON(),
			],
			flags: MessageFlags.Ephemeral,
		});
		sent.inspectErr((error) =>
			container.logger.error(
				"[subscriptions] Failed to send Twitch subscription page",
				error,
			),
		);
	}
	return response;
}
