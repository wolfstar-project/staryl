import type { Nullish } from "@sapphire/utilities";
import type {
  APIActionRowComponent,
  APIChannel,
  APIComponentInActionRow,
  APIDMChannel,
  APIGroupDMChannel,
  APIGuildMember,
  APIStringSelectComponent,
  APIThreadChannel,
} from "discord-api-types/v10";
import { BitField } from "@sapphire/bitfield";
import { isNullish } from "@sapphire/utilities";
import {
  ChannelType,
  ComponentType,
  PermissionFlagsBits,
} from "discord-api-types/v10";
import { api } from "./discord-api.js";

export function makeActionRow<Component extends APIComponentInActionRow>(
  components: Component[],
): APIActionRowComponent<APIComponentInActionRow> {
  return { type: ComponentType.ActionRow, components };
}

export function displaySelectMenuIndex(component: APIStringSelectComponent, index: number): APIStringSelectComponent {
  return {
    ...component,
    options: component.options.map((option, optionIndex) => ({
      ...option,
      default: optionIndex === index,
    })),
  };
}

const permissionsBitField = new BitField(PermissionFlagsBits);

const canReadMessagesPermissions = permissionsBitField.resolve([PermissionFlagsBits.ViewChannel]);

export async function canReadMessages(
  channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel> | Nullish,
): Promise<boolean> {
  if (isNullish(channel))
    return false;
  if (isDMChannel(channel))
    return true;

  return canDoUtility(channel, canReadMessagesPermissions);
}

const canSendMessagesPermissions = permissionsBitField.resolve([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
]);

export async function canSendMessages(
  channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel> | Nullish,
): Promise<boolean> {
  if (isNullish(channel))
    return false;
  if (isDMChannel(channel))
    return true;
  if (isThreadChannel(channel))
    return false;

  return canDoUtility(channel, canSendMessagesPermissions);
}

const canSendEmbedsPermissions = permissionsBitField.resolve([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
]);

export async function canSendEmbeds(
  channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel> | Nullish,
): Promise<boolean> {
  if (isNullish(channel))
    return false;
  if (isDMChannel(channel))
    return true;
  if (isThreadChannel(channel))
    return false;

  return canDoUtility(channel, canSendEmbedsPermissions);
}

async function canDoUtility(
  channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel>,
  permissions: bigint,
): Promise<boolean> {
  if (!isGuildChannel(channel))
    return true;

  const memberPermissions = await getMemberPermissions(channel);
  if (memberPermissions === null)
    return false;

  return permissionsBitField.has(memberPermissions, permissions);
}

// Type guards
function isDMChannel(channel: APIChannel): channel is Exclude<
  APIChannel,
  APIDMChannel | APIGroupDMChannel
> {
  return channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM;
}

function isGuildChannel(
  channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel>,
): channel is Exclude<APIChannel, APIDMChannel | APIGroupDMChannel> {
  return "guild_id" in channel;
}

function isThreadChannel(channel: APIChannel): channel is APIThreadChannel {
  return (
    channel.type === ChannelType.PrivateThread
    || channel.type === ChannelType.PublicThread
    || (channel.type === ChannelType.AnnouncementThread && channel.thread_metadata?.archived === false)
  );
}

// Helper functions
async function getMemberPermissions(
  channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel>,
): Promise<bigint | null> {
  try {
    const currentUser = await api().users.getCurrent();
    const member = (await api().guilds.getMember(String(channel.guild_id), currentUser.id)) as APIGuildMember & { permissions: string };

    return member.permissions ? BigInt(member.permissions) : null;
  }
  catch {
    return null;
  }
}
