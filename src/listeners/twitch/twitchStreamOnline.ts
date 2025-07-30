import { LanguageKeys } from '#lib/i18n/index';
import { Events } from '#lib/types';
import { floatPromise } from '#utils/common';
import { streamNotificationDrip } from '#utils/twitch';
import { extractDetailedMentions } from '#utilies/util';
import { EmbedBuilder, escapeMarkdown } from '@discordjs/builders';
import { Listener } from '@skyra/http-framework';
import type { TFunction } from '@skyra/http-framework-i18n';
import { getT } from '@skyra/http-framework-i18n';
import { isNullish, isNullishOrEmpty } from '@sapphire/utilities';
import {
	fetchStream,
	TwitchBrandingColor,
	TwitchEventSubTypes,
	type TwitchEventSubOnlineEvent,
	type TwitchHelixStreamsResult,
	type TwitchOnlineEmbedData
} from '@skyra/twitch-helpers';
import { api } from '#lib/utils/discord-api';
import type { APIChannel, APIDMChannel, APIGroupDMChannel, LocaleString } from 'discord-api-types/v10';
import { canSendEmbeds } from '#lib/utilities/discord-utilities';

export default class extends Listener {
	private readonly kTwitchImageReplacerRegex = /({width}|{height})/gi;

	public async run(data: TwitchEventSubOnlineEvent) {
		const twitchSubscription = await this.container.prisma.twitchSubscription.findFirst({
			where: {
				streamerId: data.broadcaster_user_id,
				subscriptionType: 'StreamOnline'
			},
			include: { guildSubscription: true }
		});

		if (twitchSubscription) {
			const streamData = await fetchStream(data.broadcaster_user_id);

			// Iterate over all the guilds that are subscribed to this streamer and subscription type
			for (const guildSubscription of twitchSubscription.guildSubscription) {
				if (streamNotificationDrip(`${twitchSubscription.streamerId}-${guildSubscription.channelId}-${TwitchEventSubTypes.StreamOnline}`)) {
					continue;
				}

				// Retrieve the guild, if not found, skip to the next loop cycle.
				const guild = await api().guilds.get(String(guildSubscription.guildId));
				if (typeof guild === 'undefined') continue;

				// Retrieve the language for this guild
				const t = await getT((guild.preferred_locale ?? 'en-US') as LocaleString);

				// Retrieve the channel to send the message to
				const channel = (await api().guilds.getChannels(String(guildSubscription.guildId))).find(
					(c) => c.id === String(guildSubscription.channelId)
				) as Exclude<APIChannel, APIDMChannel | APIGroupDMChannel>;
				if (isNullish(channel) || !canSendEmbeds(channel)) {
					continue;
				}

				// Construct a message embed and send it.
				// If the message could not be retrieved then skip this notification.
				if (!isNullishOrEmpty(guildSubscription.message)) {
					const detailedMentions = extractDetailedMentions(guildSubscription.message);
					floatPromise(
						await api().channels.createMessage(channel.id, {
							content: guildSubscription.message || undefined,
							embeds: [this.buildEmbed(this.transformTextToObject(data, streamData), t)],
							allowed_mentions: {
								parse: detailedMentions.parse,
								users: [...detailedMentions.users],
								roles: [...detailedMentions.roles]
							}
						})
					);
				}
			}
		}
	}

	private transformTextToObject(notification: TwitchEventSubOnlineEvent, streamData: TwitchHelixStreamsResult | null): TwitchOnlineEmbedData {
		return {
			embedThumbnailUrl: streamData?.game_box_art_url?.replace(this.kTwitchImageReplacerRegex, '128'),
			gameName: streamData?.game_name,
			language: streamData?.language,
			startedAt: new Date(notification.started_at),
			title: this.escapeText(streamData?.title),
			userName: notification.broadcaster_user_name,
			viewerCount: streamData?.viewer_count,
			embedImageUrl: streamData?.thumbnail_url.replace(this.kTwitchImageReplacerRegex, '128')
		};
	}

	private buildEmbed(data: TwitchOnlineEmbedData, t: TFunction) {
		const embed = new EmbedBuilder()
			.setTitle(data.title)
			.setURL(`https://twitch.tv/${data.userName}`)
			.setFooter({ text: t(LanguageKeys.Events.Twitch.OfflinePostfix) })
			.setColor(TwitchBrandingColor)
			.setTimestamp(data.startedAt);

		if (data.gameName) {
			embed.setDescription(t(LanguageKeys.Events.Twitch.EmbedDescriptionWithGame, { userName: data.userName, gameName: data.gameName }));
		} else {
			embed.setDescription(t(LanguageKeys.Events.Twitch.EmbedDescription, { userName: data.userName }));
		}

		if (data.embedImageUrl) {
			embed.setImage(data.embedImageUrl);
		}

		if (data.embedThumbnailUrl) {
			embed.setThumbnail(data.embedThumbnailUrl ?? '');
		}

		return embed.toJSON();
	}

	private escapeText(text?: string) {
		if (isNullish(text)) {
			return '';
		}

		return escapeMarkdown(text.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
	}
}
