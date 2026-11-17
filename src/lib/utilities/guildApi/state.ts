import type {
	SocialDeliveryError,
	SocialProviderName,
	TwitchSubscriptionType,
} from "#lib/setup/prisma";
import type { SocialFilterName } from "#social/filters";
import type { SourceHealth } from "#social/schedule";
import type { GuildSocialSubscriptionWithSource } from "#social/subscriptions";
import { getActiveFilters, parseSocialFilters } from "#social/filters";
import { getSocialProvider, SocialProviders } from "#social/registry";
import { describeSourceHealth } from "#social/schedule";
import {
	MaximumSocialSubscriptionsPerGuild,
	MaximumXAccountsPerGuild,
} from "#social/subscriptions";
import {
	fetchStreamerNames,
	MaximumMessageLength,
} from "#twitch/subscriptions";
import { api } from "#utils/discordApi";
import { DiscordAPIError } from "@discordjs/rest";
import { Result } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { areTwitchClientCredentialsSet } from "@wolfstar/twitch-helpers";

/** The longest target `add` takes, as the option of the command does. */
export const MaximumTargetInputLength = 500;

/**
 * The providers whose target is an account its owner connected. The connection starts from a link
 * only `/subscriptions <provider> connect` hands out, so the guild API lists their subscriptions
 * and changes none.
 */
const ConnectedProviders: ReadonlySet<SocialProviderName> = new Set([
	"Instagram",
	"TikTok",
]);

export function isManageableProvider(provider: SocialProviderName) {
	return !ConnectedProviders.has(provider);
}

export interface GuildApiProvider {
	name: SocialProviderName;
	/** Whether the bot holds the credentials the provider needs. */
	configured: boolean;
	/** Whether the guild API adds and removes its subscriptions. */
	manageable: boolean;
}

export interface GuildApiSubscription {
	provider: SocialProviderName;
	sourceId: string;
	channelId: string;
	displayName: string;
	/** The canonical form of what was followed: a feed URL, a handle, a channel id. */
	target: string;
	message: string | null;
	/** The filters that differ from their default. They are set with `/subscriptions`. */
	filters: SocialFilterName[];
	health: SourceHealth | "unavailable";
	deliveryError: SocialDeliveryError | null;
	manageable: boolean;
	createdAt: string;
	lastCheckedAt: string | null;
}

export interface GuildApiTwitchSubscription {
	/** The id of the shared Twitch subscription: with the channel, what a removal names. */
	subscriptionId: string;
	streamerId: string;
	/** `null` when Twitch did not answer with the name. */
	streamerName: string | null;
	channelId: string;
	type: TwitchSubscriptionType;
	message: string | null;
	/** Twitch ended the EventSub subscription, so no event arrives until it is added again. */
	revoked: boolean;
}

export interface GuildApiState {
	/** Whether the bot is a member of the guild. */
	installed: boolean;
	/** The switch of the guild's notifications. */
	enabled: boolean;
	limits: {
		subscriptions: number;
		xAccounts: number;
		messageLength: number;
		targetLength: number;
	};
	providers: GuildApiProvider[];
	/**
	 * Whether the bot can look a Twitch streamer up, which every live add needs. A streamer no
	 * channel follows yet also needs the EventSub credentials, and answers `twitch-failed` without them.
	 */
	twitchLiveConfigured: boolean;
	subscriptions: GuildApiSubscription[];
	twitch: GuildApiTwitchSubscription[];
}

export const GuildApiLimits: GuildApiState["limits"] = {
	subscriptions: MaximumSocialSubscriptionsPerGuild,
	xAccounts: MaximumXAccountsPerGuild,
	messageLength: MaximumMessageLength,
	targetLength: MaximumTargetInputLength,
};

export function listGuildApiProviders(): GuildApiProvider[] {
	return SocialProviders.map((provider) => ({
		name: provider.name,
		configured: provider.getAuthRequirements().satisfied,
		manageable: isManageableProvider(provider.name),
	}));
}

export function toGuildApiSubscription(
	subscription: GuildSocialSubscriptionWithSource,
): GuildApiSubscription {
	const { source } = subscription;
	const configured =
		getSocialProvider(source.provider)?.getAuthRequirements().satisfied ??
		false;
	return {
		provider: source.provider,
		sourceId: String(source.id),
		channelId: String(subscription.channelId),
		displayName: source.displayName,
		target: source.target,
		message: subscription.message,
		filters: getActiveFilters(parseSocialFilters(subscription.filters)),
		health: configured ? describeSourceHealth(source) : "unavailable",
		deliveryError: subscription.deliveryError,
		manageable: isManageableProvider(source.provider),
		createdAt: subscription.createdAt.toISOString(),
		lastCheckedAt: source.lastCheckedAt?.toISOString() ?? null,
	};
}

/** The guild's subscriptions, oldest first, so a new one lands at the end of the list. */
export async function readGuildApiSubscriptions(
	guildId: bigint,
): Promise<GuildApiSubscription[]> {
	const subscriptions = await container.prisma.guildSocialSubscription.findMany(
		{
			where: { guildId },
			include: { source: true },
			orderBy: { createdAt: "asc" },
		},
	);
	return subscriptions.map(toGuildApiSubscription);
}

export async function isGuildNotificationsEnabled(guildId: bigint) {
	const guild = await container.prisma.guild.findUnique({
		where: { id: guildId },
		select: { notificationsEnabled: true },
	});
	// A guild has no row until its first subscription, and its notifications are on by default.
	return guild?.notificationsEnabled ?? true;
}

/**
 * Stores the switch and answers what it was, so a caller can tell a change from a repeat.
 *
 * The read and the write share a lock on the guild: two requests at once would otherwise both read
 * the same value, and both report a change only one of them made.
 */
export function setGuildNotificationsEnabled(
	guildId: bigint,
	enabled: boolean,
) {
	return container.prisma.$transaction(async (transaction) => {
		await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${guildId})`;
		const guild = await transaction.guild.findUnique({
			where: { id: guildId },
			select: { notificationsEnabled: true },
		});
		await transaction.guild.upsert({
			where: { id: guildId },
			create: { id: guildId, notificationsEnabled: enabled },
			update: { notificationsEnabled: enabled },
			select: { id: true },
		});
		return guild?.notificationsEnabled ?? true;
	});
}

export async function readGuildApiState(
	guildId: bigint,
): Promise<GuildApiState> {
	const [installed, enabled, subscriptions, twitch] = await Promise.all([
		isInstalled(guildId),
		isGuildNotificationsEnabled(guildId),
		readGuildApiSubscriptions(guildId),
		readTwitchSubscriptions(guildId),
	]);
	return {
		installed,
		enabled,
		limits: GuildApiLimits,
		providers: listGuildApiProviders(),
		twitchLiveConfigured: isTwitchLiveConfigured(),
		subscriptions,
		twitch,
	};
}

/**
 * Discord answers 403 or 404 for a guild the bot is not in. Anything else is Discord failing, and
 * an outage must not read as "the bot was removed".
 */
async function isInstalled(guildId: bigint) {
	const result = await Result.fromAsync(() =>
		api().guilds.get(String(guildId)),
	);
	if (result.isOk()) return true;

	const error = result.unwrapErr();
	if (
		error instanceof DiscordAPIError &&
		(error.status === 403 || error.status === 404)
	) {
		return false;
	}

	container.logger.warn(
		`[guild-api] Could not tell whether the bot is in guild ${guildId}`,
		error,
	);
	return true;
}

export function isTwitchLiveConfigured() {
	return areTwitchClientCredentialsSet();
}

/** The guild's Twitch live subscriptions, with the streamers' names when Twitch answers. */
export async function readTwitchSubscriptions(
	guildId: bigint,
): Promise<GuildApiTwitchSubscription[]> {
	const subscriptions = await container.prisma.guildSubscription.findMany({
		where: { guildId },
		include: { twitchSubscription: true },
		// A stable order. The shared row is the closest thing to a creation date this table has.
		orderBy: { subscriptionId: "asc" },
	});
	if (subscriptions.length === 0) return [];

	// Logs and skips the names Twitch does not answer with, so the list still comes back.
	const names = await fetchStreamerNames(
		subscriptions.map((entry) => entry.twitchSubscription.streamerId),
	);
	return subscriptions.map((entry) => ({
		subscriptionId: String(entry.subscriptionId),
		streamerId: entry.twitchSubscription.streamerId,
		streamerName: names.get(entry.twitchSubscription.streamerId) ?? null,
		channelId: String(entry.channelId),
		type: entry.twitchSubscription.subscriptionType,
		message: entry.message,
		revoked: entry.twitchSubscription.revokedReason !== null,
	}));
}
