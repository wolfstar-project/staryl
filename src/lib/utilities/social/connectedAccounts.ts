import type { SocialProviderName, SocialConnection } from "#lib/setup/prisma";
import type { ProviderFailure, SocialItem } from "#social/provider";
import type { Result } from "@sapphire/result";
import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	createHash,
} from "node:crypto";
import { DefaultSocialFilters } from "#social/filters";
import { addSocialSubscription } from "#social/subscriptions";
import { api } from "#utils/discordApi";
import { err, ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { PermissionFlagsBits } from "discord-api-types/v10";

export interface ConnectedToken {
	accessToken: string;
	refreshToken?: string;
	accountId: string;
	displayName: string;
	expiresAt: number;
}
export interface ConnectedAccountApi {
	name: SocialProviderName;
	redirectUri: string;
	configured: boolean;
	refreshWindowMs: number;
	authorize(state: string): string;
	exchange(code: string): Promise<Result<ConnectedToken, ProviderFailure>>;
	refresh(
		token: ConnectedToken,
	): Promise<Result<ConnectedToken, ProviderFailure>>;
	media(token: ConnectedToken): Promise<Result<SocialItem[], ProviderFailure>>;
}

/** An authenticated encrypted envelope; swapping ciphertext or using the wrong key fails closed. */
export function sealSocialToken(token: ConnectedToken, key: string) {
	if (!/^[a-f\d]{64}$/i.test(key))
		throw new Error("SOCIAL_TOKEN_KEY must be 32 bytes in hex");
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(token)),
		cipher.final(),
	]);
	return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
		"base64",
	);
}
export function openSocialToken(envelope: string, key: string): ConnectedToken {
	const data = Buffer.from(envelope, "base64");
	const decipher = createDecipheriv(
		"aes-256-gcm",
		Buffer.from(key, "hex"),
		data.subarray(0, 12),
	);
	decipher.setAuthTag(data.subarray(12, 28));
	return JSON.parse(
		Buffer.concat([
			decipher.update(data.subarray(28)),
			decipher.final(),
		]).toString(),
	) as ConnectedToken;
}
const hashState = (state: string) =>
	createHash("sha256").update(state).digest("hex");

export async function canManageSocialGuild(guildId: string, userId: string) {
	const guild = await api().guilds.get(guildId);
	if (guild.owner_id === userId) return true;
	const [member, roles] = await Promise.all([
		api().guilds.getMember(guildId, userId),
		api().guilds.getRoles(guildId),
	]);
	const bits = roles
		.filter((role) => role.id === guildId || member.roles.includes(role.id))
		.reduce((permissions, role) => permissions | BigInt(role.permissions), 0n);
	return (
		(bits &
			(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.Administrator)) !==
		0n
	);
}

export async function beginSocialConnection(
	client: ConnectedAccountApi,
	guildId: bigint,
	channelId: bigint,
	userId: string,
) {
	if (
		!client.configured ||
		!/^[a-f\d]{64}$/i.test(process.env.SOCIAL_TOKEN_KEY ?? "")
	)
		return null;
	const channel = await api().channels.get(String(channelId));
	if (!("guild_id" in channel) || channel.guild_id !== String(guildId))
		return null;
	if (!(await canManageSocialGuild(String(guildId), userId))) return null;
	const state = randomBytes(32).toString("hex");
	await container.prisma.socialOAuthState.deleteMany({
		where: { expiresAt: { lt: new Date() } },
	});
	await container.prisma.socialOAuthState.create({
		data: {
			id: hashState(state),
			provider: client.name,
			guildId,
			channelId,
			userId,
			expiresAt: new Date(Date.now() + 600_000),
		},
	});
	return client.authorize(state);
}

export async function finishSocialConnection(
	client: ConnectedAccountApi,
	state: string,
	code: string,
) {
	if (!client.configured || !/^[a-f\d]{64}$/i.test(state)) return false;
	const pending = await container.prisma.socialOAuthState.findUnique({
		where: { id: hashState(state) },
	});
	if (
		!pending ||
		pending.provider !== client.name ||
		pending.expiresAt.getTime() <= Date.now()
	)
		return false;
	if (!(await canManageSocialGuild(String(pending.guildId), pending.userId)))
		return false;
	const consumed = await container.prisma.socialOAuthState.deleteMany({
		where: { id: pending.id, expiresAt: { gt: new Date() } },
	});
	if (consumed.count !== 1) return false;
	const grant = await client.exchange(code);
	if (grant.isErr()) return false;
	const token = grant.unwrap();
	const target = `${pending.guildId}:${token.accountId}`;
	const data = {
		guildId: pending.guildId,
		displayName: token.displayName,
		credentials: sealSocialToken(token, process.env.SOCIAL_TOKEN_KEY!),
		expiresAt: new Date(token.expiresAt),
		refreshingUntil: null,
	};
	await container.prisma.socialConnection.upsert({
		where: { provider_target: { provider: client.name, target } },
		create: { provider: client.name, target, ...data },
		update: data,
	});
	const added = await addSocialSubscription({
		guildId: pending.guildId,
		channelId: pending.channelId,
		providerName: client.name,
		input: target,
		message: null,
		filters: DefaultSocialFilters,
	});
	// Re-authorization repairs an existing subscription too.
	if (added.isErr() && added.unwrapErr() !== "commands/social:addDuplicated")
		return false;
	await container.prisma.socialSource.updateMany({
		where: { provider: client.name, target },
		data: { checkRequested: true },
	});
	return true;
}

export async function readConnectedMedia(
	client: ConnectedAccountApi,
	target: string,
) {
	const connection = await container.prisma.socialConnection.findUnique({
		where: { provider_target: { provider: client.name, target } },
	});
	if (!connection) return err<ProviderFailure>({ _tag: "AuthFailed" });
	let token = openSocialToken(
		connection.credentials,
		process.env.SOCIAL_TOKEN_KEY!,
	);
	if (token.expiresAt <= Date.now() + client.refreshWindowMs) {
		const refreshed = await refreshConnection(client, connection, token);
		if (refreshed.isErr()) return err(refreshed.unwrapErr());
		token = refreshed.unwrap();
	}
	return client.media(token);
}

async function refreshConnection(
	client: ConnectedAccountApi,
	connection: SocialConnection,
	token: ConnectedToken,
): Promise<Result<ConnectedToken, ProviderFailure>> {
	const where = {
		provider: connection.provider,
		target: connection.target,
		credentials: connection.credentials,
	};
	const lease = new Date(Date.now() + 60_000);
	const claimed = await container.prisma.socialConnection.updateMany({
		where: {
			...where,
			OR: [{ refreshingUntil: null }, { refreshingUntil: { lt: new Date() } }],
		},
		data: { refreshingUntil: lease },
	});
	if (claimed.count !== 1)
		return err({ _tag: "RateLimited", retryAfterMs: 60_000 });
	try {
		const refreshed = await client.refresh(token);
		if (refreshed.isErr()) return refreshed;
		const next = refreshed.unwrap();
		const saved = await container.prisma.socialConnection.updateMany({
			where: { ...where, refreshingUntil: lease },
			data: {
				credentials: sealSocialToken(next, process.env.SOCIAL_TOKEN_KEY!),
				expiresAt: new Date(next.expiresAt),
			},
		});
		return saved.count === 1 ? ok(next) : err({ _tag: "AuthFailed" });
	} finally {
		await container.prisma.socialConnection.updateMany({
			where: {
				provider: connection.provider,
				target: connection.target,
				refreshingUntil: lease,
			},
			data: { refreshingUntil: null },
		});
	}
}
