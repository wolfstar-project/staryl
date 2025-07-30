import { LanguageKeys } from '#lib/i18n';
import { Events } from '#lib/types';
import { floatPromise } from '#common/promises';
import { streamNotificationDrip } from '#utils/twitch';
import { extractDetailedMentions } from '#utils/util';
import { TimestampStyles, time } from '@discordjs/builders';
import { Listener } from '@skyra/http-framework';
import type { TFunction } from '@skyra/http-framework-i18n';
import { getT } from '@skyra/http-framework-i18n';
import { isNullish, isNullishOrEmpty } from '@sapphire/utilities';
import { TwitchEventSubTypes, type TwitchEventSubEvent } from '@skyra/twitch-helpers';
import { api } from '#lib/utils/discord-api';
import type { APIChannel, APIDMChannel, APIGroupDMChannel, LocaleString } from 'discord-api-types/v10';
import { canSendMessages } from '#lib/utilities/discord-utilities';

export default class extends Listener {
	public async run(data: TwitchEventSubEvent) {
		const date = new Date();

		const twitchSubscription = await this.container.prisma.twitchSubscription.findFirst({
			where: {
				streamerId: data.broadcaster_user_id,
				subscriptionType: 'StreamOffline'
			},
			include: { guildSubscription: true }
		});

		if (twitchSubscription) {
			// Iterate over all the guilds that are subscribed to this streamer and subscription type
			for (const guildSubscription of twitchSubscription.guildSubscription) {
				if (streamNotificationDrip(`${twitchSubscription.streamerId}-${guildSubscription.channelId}-${TwitchEventSubTypes.StreamOffline}`)) {
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
				if (isNullish(channel) || !canSendMessages(channel)) {
					continue;
				}

				// Construct a message embed and send it.
				// If the message could not be retrieved then skip this notification.
				if (!isNullishOrEmpty(guildSubscription.message)) {
					const detailedMentions = extractDetailedMentions(guildSubscription.message);
					floatPromise(
						await api().channels.createMessage(channel.id, {
							content: this.buildMessage(guildSubscription.message, date, t),
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

	private buildMessage(message: string, date: Date, t: TFunction): string {
		return `${message} | ${time(date, TimestampStyles.ShortDateTime)} | ${t(LanguageKeys.Events.Twitch.OfflinePostfix)}`;
	}
}
