import type { Nullish } from "@sapphire/utilities";
import type {
	APIActionRowComponent,
	APIChannel,
	APIComponentInActionRow,
	APIDMChannel,
	APIGuildMember,
	APIGroupDMChannel,
	APIRole,
	APIStringSelectComponent,
	APIThreadChannel,
} from "discord-api-types/v10";
import { BitField } from "@sapphire/bitfield";
import { isNullish } from "@sapphire/utilities";
import {
	ChannelType,
	ComponentType,
	OverwriteType,
	PermissionFlagsBits,
} from "discord-api-types/v10";
import { api } from "./discordApi.js";

export function makeActionRow<Component extends APIComponentInActionRow>(
	components: Component[],
): APIActionRowComponent<APIComponentInActionRow> {
	return { type: ComponentType.ActionRow, components };
}

export function displaySelectMenuIndex(
	component: APIStringSelectComponent,
	index: number,
): APIStringSelectComponent {
	return {
		...component,
		options: component.options.map((option, optionIndex) => ({
			...option,
			default: optionIndex === index,
		})),
	};
}

const permissionsBitField = new BitField(PermissionFlagsBits);

const canReadMessagesPermissions = permissionsBitField.resolve([
	PermissionFlagsBits.ViewChannel,
]);

export async function canReadMessages(
	channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel> | Nullish,
	roles: APIRole[],
): Promise<boolean> {
	if (isNullish(channel)) return false;
	if (isDMChannel(channel)) return true;

	return canDoUtility(channel, canReadMessagesPermissions, roles);
}

const canSendMessagesPermissions = permissionsBitField.resolve([
	PermissionFlagsBits.ViewChannel,
	PermissionFlagsBits.SendMessages,
]);

export async function canSendMessages(
	channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel> | Nullish,
	roles: APIRole[],
): Promise<boolean> {
	if (isNullish(channel)) return false;
	if (isDMChannel(channel)) return true;
	if (isThreadChannel(channel)) return false;

	return canDoUtility(channel, canSendMessagesPermissions, roles);
}

const canSendEmbedsPermissions = permissionsBitField.resolve([
	PermissionFlagsBits.ViewChannel,
	PermissionFlagsBits.SendMessages,
	PermissionFlagsBits.EmbedLinks,
]);

export async function canSendEmbeds(
	channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel> | Nullish,
	roles: APIRole[],
): Promise<boolean> {
	if (isNullish(channel)) return false;
	if (isDMChannel(channel)) return true;
	if (isThreadChannel(channel)) return false;

	return canDoUtility(channel, canSendEmbedsPermissions, roles);
}

async function canDoUtility(
	channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel>,
	permissions: bigint,
	roles: APIRole[],
): Promise<boolean> {
	if (!isGuildChannel(channel)) return true;

	const memberPermissions = await getMemberPermissions(channel, roles);
	if (memberPermissions === null) return false;
	if (
		permissionsBitField.has(
			memberPermissions,
			PermissionFlagsBits.Administrator,
		)
	) {
		return true;
	}

	return permissionsBitField.has(memberPermissions, permissions);
}

// Type guards
function isDMChannel(
	channel: APIChannel,
): channel is Exclude<APIChannel, APIDMChannel | APIGroupDMChannel> {
	return (
		channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM
	);
}

function isGuildChannel(
	channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel>,
): channel is Exclude<APIChannel, APIDMChannel | APIGroupDMChannel> {
	return "guild_id" in channel;
}

function isThreadChannel(channel: APIChannel): channel is APIThreadChannel {
	return (
		channel.type === ChannelType.PrivateThread ||
		channel.type === ChannelType.PublicThread ||
		(channel.type === ChannelType.AnnouncementThread &&
			channel.thread_metadata?.archived === false)
	);
}

// Helper functions
async function getMemberPermissions(
	channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel>,
	roles: APIRole[],
): Promise<bigint | null> {
	try {
		if (isNullish(channel.guild_id)) return null;

		const currentUser = await api().users.getCurrent();
		const member = await api().guilds.getMember(
			String(channel.guild_id),
			currentUser.id,
		);

		return calculateMemberPermissions(channel, member, roles, currentUser.id);
	} catch {
		return null;
	}
}

function calculateMemberPermissions(
	channel: Exclude<APIChannel, APIDMChannel | APIGroupDMChannel>,
	member: APIGuildMember,
	roles: APIRole[],
	memberId: string,
): bigint | null {
	if (isNullish(channel.guild_id)) return null;

	const roleIds = new Set(member.roles);
	let permissions = roles
		.filter((role) => role.id === channel.guild_id || roleIds.has(role.id))
		.reduce((resolvedPermissions, role) => {
			return resolvedPermissions | BigInt(role.permissions);
		}, 0n);

	if (permissionsBitField.has(permissions, PermissionFlagsBits.Administrator)) {
		return permissions;
	}

	const overwrites = channel.permission_overwrites ?? [];
	const everyoneOverwrite = overwrites.find(
		(overwrite) =>
			overwrite.type === OverwriteType.Role &&
			overwrite.id === channel.guild_id,
	);
	permissions = applyOverwrite(permissions, everyoneOverwrite);

	let roleAllow = 0n;
	let roleDeny = 0n;
	for (const overwrite of overwrites) {
		if (
			overwrite.type === OverwriteType.Role &&
			overwrite.id !== channel.guild_id &&
			roleIds.has(overwrite.id)
		) {
			roleAllow |= BigInt(overwrite.allow);
			roleDeny |= BigInt(overwrite.deny);
		}
	}
	permissions = (permissions & ~roleDeny) | roleAllow;

	const memberOverwrite = overwrites.find(
		(overwrite) =>
			overwrite.type === OverwriteType.Member && overwrite.id === memberId,
	);
	return applyOverwrite(permissions, memberOverwrite);
}

function applyOverwrite(
	permissions: bigint,
	overwrite: { allow: string; deny: string } | undefined,
): bigint {
	if (isNullish(overwrite)) return permissions;

	return (permissions & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow);
}
