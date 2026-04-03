import type {
  GuildSubscription,
  TwitchSubscriptionType,
} from "#lib/setup/prisma";
import type { APIChannel } from "discord-api-types/v10";
import { LanguageKeys } from "#i18n/languageKeys";
import { channelMention } from "@discordjs/formatters";
import { Result } from "@sapphire/result";
import { cast, isNullishOrEmpty } from "@sapphire/utilities";
import {
  Command,
  RegisterCommand,
  RegisterSubcommand,
} from "@skyra/http-framework";
import { resolveKey } from "@skyra/http-framework-i18n";
import {
  addEventSubscription,
  fetchUsers,
  TwitchEventSubTypes,
} from "@skyra/twitch-helpers";
import { MessageFlags, PermissionFlagsBits } from "discord-api-types/v10";

@RegisterCommand((builder) =>
  builder
    .setName("twitch-subscription")
    .setDescription(LanguageKeys.Commands.Twitch.TwitchSubscriptionDescription)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
)
export class UserCommand extends Command {
  @RegisterSubcommand((builder) =>
    builder
      .setName("add")
      .setDescription(
        LanguageKeys.Commands.Twitch.TwitchSubscriptionAddDescription,
      )
      .addStringOption((option) =>
        option
          .setName("streamer")
          .setDescription("The Twitch streamer")
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("The Discord channel")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("type")
          .setDescription("Subscription type")
          .setRequired(true)
          .addChoices(
            { name: "Stream Online", value: "StreamOnline" },
            { name: "Stream Offline", value: "StreamOffline" },
          ),
      )
      .addStringOption((option) =>
        option
          .setName("message")
          .setDescription("Custom message")
          .setRequired(false),
      ),
  )
  public async add(
    interaction: Command.ChatInputInteraction,
    options: Options,
  ) {
    const streamer = await this.#getStreamer(options.streamer);
    if (!streamer) {
      return interaction.reply({
        content: await resolveKey(
          interaction,
          LanguageKeys.Commands.Twitch.TwitchSubscriptionStreamerNotFound,
        ),
        flags: MessageFlags.Ephemeral,
      });
    }

    const { channel } = options;
    const subscriptionType = options.type as TwitchSubscriptionType;
    const customMessage = options.message;

    if (
      subscriptionType === "StreamOffline" &&
      isNullishOrEmpty(customMessage)
    ) {
      return interaction.reply({
        content: await resolveKey(
          interaction,
          LanguageKeys.Commands.Twitch
            .TwitchSubscriptionAddMessageForOfflineRequired,
        ),
        flags: MessageFlags.Ephemeral,
      });
    }

    const streamerForType =
      await this.container.prisma.twitchSubscription.findFirst({
        where: { streamerId: streamer.id, subscriptionType },
      });

    const guildSubscriptionsForGuild =
      await this.container.prisma.guildSubscription.findMany({
        where: {
          guildId: BigInt(interaction.guildId!),
          channelId: BigInt(channel.id),
        },
        include: { twitchSubscription: true },
      });

    const alreadyHasEntry = guildSubscriptionsForGuild.some(
      (guildSubscription) =>
        guildSubscription.twitchSubscription.streamerId === streamer.id &&
        guildSubscription.twitchSubscription.subscriptionType ===
          subscriptionType,
    );

    if (alreadyHasEntry) {
      return interaction.reply({
        content: await resolveKey(
          interaction,
          LanguageKeys.Commands.Twitch.TwitchSubscriptionAddDuplicated,
        ),
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      if (streamerForType) {
        await this.container.prisma.guildSubscription.create({
          data: {
            guildId: BigInt(interaction.guildId!),
            channelId: BigInt(channel.id),
            message: customMessage ?? undefined,
            subscriptionId: streamerForType.id,
          },
          select: null,
        });
      } else {
        const subscription = await addEventSubscription(
          streamer.id,
          TwitchEventSubTypes[subscriptionType],
        );
        await this.container.prisma.guildSubscription.create({
          data: {
            guildId: BigInt(interaction.guildId!),
            channelId: BigInt(channel.id),
            message: customMessage ?? undefined,
            subscriptionId: Number(subscription.id),
          },
          select: null,
        });
      }

      const content = cast<string>(
        await resolveKey(
          interaction,
          subscriptionType === "StreamOnline"
            ? LanguageKeys.Commands.Twitch.TwitchSubscriptionAddSuccessLive
            : LanguageKeys.Commands.Twitch.TwitchSubscriptionAddSuccessOffline,
          { name: streamer.display_name, channel: channelMention(channel.id) },
        ),
      );

      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch {
      return interaction.reply({
        content:
          "An error occurred while trying to add the subscription. Please try again later.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  @RegisterSubcommand((builder) =>
    builder
      .setName("remove")
      .setDescription(
        LanguageKeys.Commands.Twitch.TwitchSubscriptionRemoveDescription,
      )
      .addStringOption((option) =>
        option
          .setName("streamer")
          .setDescription("The Twitch streamer")
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("The Discord channel")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("type")
          .setDescription("Subscription type")
          .setRequired(true)
          .addChoices(
            { name: "Stream Online", value: "StreamOnline" },
            { name: "Stream Offline", value: "StreamOffline" },
          ),
      ),
  )
  public async remove(
    interaction: Command.ChatInputInteraction,
    options: Options,
  ) {
    const streamer = await this.#getStreamer(options.streamer);
    if (!streamer) {
      return interaction.reply({
        content: await resolveKey(
          interaction,
          LanguageKeys.Commands.Twitch.TwitchSubscriptionStreamerNotFound,
        ),
        flags: MessageFlags.Ephemeral,
      });
    }

    const { channel } = options;
    const subscriptionType = options.type as TwitchSubscriptionType;

    const guildSubscriptions = await this.getGuildSubscriptions(
      BigInt(interaction.guildId!),
    );

    const streamers = guildSubscriptions.filter(
      ({ twitchSubscription }) => twitchSubscription.streamerId === streamer.id,
    );

    if (!streamers.length) {
      return interaction.reply({
        content: cast<string>(
          await resolveKey(
            interaction,
            LanguageKeys.Commands.Twitch
              .TwitchSubscriptionRemoveStreamerNotSubscribed,
            {
              streamer: streamer.display_name,
            },
          ),
        ),
        flags: MessageFlags.Ephemeral,
      });
    }

    const statuses = streamers.filter(
      ({ twitchSubscription }) =>
        twitchSubscription.subscriptionType === subscriptionType,
    );

    if (!statuses.length) {
      return interaction.reply({
        content: cast<string>(
          await resolveKey(
            interaction,
            LanguageKeys.Commands.Twitch
              .TwitchSubscriptionRemoveStreamerStatusNotMatch,
            {
              streamer: streamer.display_name,
              status: this.getSubscriptionStatus(subscriptionType),
            },
          ),
        ),
        flags: MessageFlags.Ephemeral,
      });
    }

    const streamerWithStatusHasChannel = statuses.find(
      (guildSubscription) => guildSubscription.channelId === BigInt(channel.id),
    );

    if (!streamerWithStatusHasChannel) {
      return interaction.reply({
        content: cast<string>(
          await resolveKey(
            interaction,
            LanguageKeys.Commands.Twitch
              .TwitchSubscriptionRemoveNotToProvidedChannel,
            { channel },
          ),
        ),
        flags: MessageFlags.Ephemeral,
      });
    }

    await this.#deleteSubscription(streamerWithStatusHasChannel);
    await this.#removeSubscription(streamerWithStatusHasChannel.subscriptionId);

    const content = cast<string>(
      await resolveKey(
        interaction,
        subscriptionType === "StreamOnline"
          ? LanguageKeys.Commands.Twitch.TwitchSubscriptionRemoveSuccessLive
          : LanguageKeys.Commands.Twitch.TwitchSubscriptionRemoveSuccessOffline,
        { name: streamer.display_name, channel: channelMention(channel.id) },
      ),
    );
    return interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  private async getGuildSubscriptions(guildId: bigint) {
    const guildSubscriptionForGuildResult = await Result.fromAsync(() =>
      this.container.prisma.guildSubscription.findMany({
        where: { guildId },
        include: { twitchSubscription: true },
      }),
    );
    const guildSubscriptionForGuild =
      guildSubscriptionForGuildResult.unwrapOrElse(() => {
        throw new Error(
          LanguageKeys.Commands.Twitch.TwitchSubscriptionNoSubscriptions,
        );
      });

    return guildSubscriptionForGuild;
  }

  private getSubscriptionStatus(subscription: TwitchSubscriptionType) {
    return subscription === "StreamOnline" ? "Live" : "Offline";
  }

  async #getStreamer(streamerName: string) {
    const { data } = (await fetchUsers({ logins: [streamerName] })).unwrapRaw();
    if (data.length > 0) return data[0];
    return null;
  }

  async #deleteSubscription(subscription: GuildSubscription) {
    await this.container.prisma.guildSubscription.delete({
      where: {
        guildId_channelId_subscriptionId: {
          guildId: subscription.guildId,
          channelId: subscription.channelId,
          subscriptionId: subscription.subscriptionId,
        },
      },
      select: null,
    });
  }

  async #removeSubscription(subscription: bigint) {
    await this.container.prisma.twitchSubscription.delete({
      where: { id: subscription },
      select: null,
    });
  }
}

interface Options {
  streamer: string;
  channel: APIChannel;
  type: TwitchSubscriptionType;
  message: string;
}
