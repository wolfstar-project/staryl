import type {
	GuildSocialSubscription,
	Prisma,
	SocialProviderName,
	SocialSource,
} from "#lib/setup/prisma";
import type { ShortsFilter, SocialFilters } from "#social/filters";
import type {
	FetchOutcome,
	ProviderFailure,
	ResolvedTarget,
	SocialItem,
	SocialProvider,
	TargetError,
} from "#social/provider";
import type { NotificationDeliveryError } from "#utils/notificationDelivery";
import type { APIChannel } from "discord-api-types/v10";
import { getActiveFilters } from "#social/filters";
import { isNsfwChannel, socialDelivery } from "#social/notifications";
import { parseXHandle } from "#social/providers/x";
import { getSocialProvider, SocialProviders } from "#social/registry";
import { MaximumFetchedItems, toSeenId } from "#social/seen";
import { SlashCommandStringOption } from "@discordjs/builders";
import { err, ok, Result } from "@sapphire/result";
import { cast, cutText } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";
import {
	applyLocalizedBuilder,
	createSelectMenuChoiceName,
} from "@wolfstar/plugin-i18next";

/**
 * The name of the subcommand group holding the social subcommands.
 *
 * Must match the group declared on the parent command.
 */
export const SocialGroupName = "social";

/**
 * A guild can follow this many sources. Each one costs requests to a third party on a timer, so
 * the limit is what keeps one guild from turning the bot into a crawler.
 */
export const MaximumSocialSubscriptionsPerGuild = 25;
export const MaximumXAccountsPerGuild = 2;

/** Match the columns of `SocialSource`, so a long feed title cannot fail the insert. */
const MaximumTargetLength = 512;
const MaximumDisplayNameLength = 200;

export type GuildSocialSubscriptionWithSource = GuildSocialSubscription & {
	source: SocialSource;
};

export interface SocialSubscriptionKey {
	guildId: bigint;
	channelId: bigint;
	sourceId: bigint;
}

export interface SocialAddOptions {
	provider: SocialProviderName;
	target: string;
	channel: APIChannel;
	message?: string;
	keywords?: string;
	exclude_keywords?: string;
	flairs?: string;
	minimum_score?: number;
	exclude_replies?: boolean;
	exclude_reposts?: boolean;
	shorts?: ShortsFilter;
}

export interface SocialSubscriptionOptions {
	source: string;
	channel: APIChannel;
}

export type SocialRemoveOptions = Pick<SocialSubscriptionOptions, "source"> &
	Partial<SocialSubscriptionOptions>;

export type AddSocialSubscriptionError =
	| "commands/social:addProviderNotConfigured"
	| "commands/social:addFilterUnsupported"
	| "commands/social:addLimitReached"
	| "commands/social:addXLimitReached"
	| "commands/social:addTargetInvalid"
	| "commands/social:addTargetNotFound"
	| "commands/social:addTargetBlocked"
	| "commands/social:addTargetUnsupported"
	| "commands/social:addTargetUnreachable"
	| "commands/social:addDuplicated"
	| "commands/social:addFailedDatabase";

export type TestSocialSubscriptionError =
	| NotificationDeliveryError
	| "providerNotConfigured"
	| "targetUnreachable"
	| "noItems";

const TargetErrorKeys = {
	InvalidTarget: "commands/social:addTargetInvalid",
	TargetNotFound: "commands/social:addTargetNotFound",
	TargetBlocked: "commands/social:addTargetBlocked",
	TargetUnsupported: "commands/social:addTargetUnsupported",
	TargetUnreachable: "commands/social:addTargetUnreachable",
} as const satisfies Record<TargetError["_tag"], AddSocialSubscriptionError>;

export function createProviderOption() {
	return applyLocalizedBuilder(
		new SlashCommandStringOption(),
		"commands/social:optionsProviderName",
		"commands/social:optionsProviderDescription",
	)
		.setRequired(true)
		.addChoices(
			...SocialProviders.map(({ name }) =>
				createSelectMenuChoiceName(
					cast<"commands/social:providerRss">(
						`commands/social:provider${name}`,
					),
					{ value: name },
				),
			),
		);
}

export function createSourceOption() {
	return applyLocalizedBuilder(
		new SlashCommandStringOption(),
		"commands/social:optionsSourceName",
		"commands/social:optionsSourceDescription",
	)
		.setRequired(true)
		.setAutocomplete(true);
}

/** The value of the `source` option is an id only when it came from the autocomplete. */
export function parseSourceId(value: string) {
	return /^\d{1,19}$/.test(value) ? BigInt(value) : null;
}

export function getGuildSocialSubscriptions(
	guildId: bigint,
): Promise<Result<GuildSocialSubscriptionWithSource[], unknown>> {
	return Result.fromAsync(() =>
		container.prisma.guildSocialSubscription.findMany({
			where: { guildId },
			include: { source: true },
		}),
	);
}

/**
 * Links a target to a channel.
 *
 * The target is fetched here rather than left to the poller for two reasons: a bad URL has to fail
 * while the member is still looking at the command, and whatever the source lists right now has to
 * count as seen, or the first check would post its whole backlog.
 */
export async function addSocialSubscription(options: {
	guildId: bigint;
	channelId: bigint;
	providerName: SocialProviderName;
	input: string;
	message: string | null;
	filters: SocialFilters;
}): Promise<Result<{ displayName: string }, AddSocialSubscriptionError>> {
	const { guildId, channelId, providerName, input, message, filters } = options;

	const provider = getSocialProvider(providerName);
	if (!provider?.getAuthRequirements().satisfied) {
		return err("commands/social:addProviderNotConfigured");
	}

	const unsupported = getActiveFilters(filters).some(
		(filter) => !provider.supportedFilters.has(filter),
	);
	if (unsupported) return err("commands/social:addFilterUnsupported");

	const limitError = await checkGuildLimit(guildId);
	if (limitError) return err(limitError);

	let xTargets: Set<string> | undefined;
	if (providerName === "X") {
		const followed = await Result.fromAsync(() =>
			container.prisma.guildSocialSubscription.findMany({
				where: { guildId, source: { provider: "X" } },
				include: { source: true },
			}),
		);
		if (followed.isErr()) return err("commands/social:addFailedDatabase");
		const sources = followed
			.unwrap()
			.map((subscription) => subscription.source);
		const handle = parseXHandle(input.trim());
		const previousHandle = sources.find(
			(source) =>
				parseXHandle(source.displayName) === handle && handle !== null,
		);
		if (
			!previousHandle &&
			new Set(sources.map((source) => source.target)).size >=
				MaximumXAccountsPerGuild
		)
			return err("commands/social:addXLimitReached");
		xTargets = new Set(sources.map((source) => source.target));
	}
	const resolved = await callProvider<ResolvedTarget, TargetError>(
		() => provider.validateTarget(input.trim()),
		{ _tag: "TargetUnreachable" },
	);
	if (resolved.isErr()) return err(TargetErrorKeys[resolved.unwrapErr()._tag]);

	const { target } = resolved.unwrap();
	if (providerName === "Instagram" && !target.startsWith(`${guildId}:`))
		return err("commands/social:addTargetBlocked");
	if (
		xTargets &&
		xTargets.size >= MaximumXAccountsPerGuild &&
		!xTargets.has(target)
	)
		return err("commands/social:addXLimitReached");
	if (target.length > MaximumTargetLength) {
		return err("commands/social:addTargetUnsupported");
	}

	const displayName = cutText(
		resolved.unwrap().displayName.replaceAll("\0", ""),
		MaximumDisplayNameLength,
	);
	const duplicateResult = await Result.fromAsync(() =>
		container.prisma.guildSocialSubscription.findFirst({
			where: { guildId, channelId, source: { provider: providerName, target } },
		}),
	);
	if (duplicateResult.isErr()) {
		logFailure("look for a duplicate", duplicateResult.unwrapErr());
		return err("commands/social:addFailedDatabase");
	}
	if (duplicateResult.unwrap() !== null) {
		return err("commands/social:addDuplicated");
	}

	const baseline = await callProvider<FetchOutcome, ProviderFailure>(
		() => provider.fetchLatest(target, null),
		{ _tag: "Unavailable" },
	);
	if (baseline.isErr()) {
		logFailure(`read ${target} for its baseline`, baseline.unwrapErr());
		return err("commands/social:addTargetUnreachable");
	}

	const outcome = baseline.unwrap();
	const seenItemIds =
		outcome._tag === "Items"
			? outcome.items.slice(0, MaximumFetchedItems).map(toSeenId)
			: [];

	// Asked again: validating a target can take seconds, which is plenty of time for parallel adds
	// to all pass the first check.
	const finalLimitError = await checkGuildLimit(guildId);
	if (finalLimitError) return err(finalLimitError);

	const createInput = {
		data: {
			channelId,
			message,
			filters: toStoredFilters(filters),
			seenItemIds,
			guild: {
				connectOrCreate: {
					where: { id: guildId },
					create: { id: guildId },
				},
			},
			source: {
				connectOrCreate: {
					where: { provider_target: { provider: providerName, target } },
					create: {
						provider: providerName,
						target,
						displayName,
						state:
							outcome._tag === "Items"
								? (outcome.state ?? undefined)
								: undefined,
						nextCheckAt: new Date(Date.now() + provider.checkIntervalMs),
					},
				},
			},
		},
		select: null,
	} satisfies Prisma.GuildSocialSubscriptionCreateArgs;

	const createdResult = await Result.fromAsync(async () => {
		if (providerName !== "X") {
			await container.prisma.guildSocialSubscription.create(createInput);
			return null;
		}
		// Serialize paid-account additions for a guild across all bot processes.
		return container.prisma.$transaction(async (transaction) => {
			await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${guildId})`;
			const subscriptions = await transaction.guildSocialSubscription.findMany({
				where: { guildId },
				include: { source: true },
			});
			const accounts = new Set(
				subscriptions
					.filter((subscription) => subscription.source.provider === "X")
					.map((subscription) => subscription.source.target),
			);

			if (subscriptions.length >= MaximumSocialSubscriptionsPerGuild)
				return "commands/social:addLimitReached" as const;
			if (!accounts.has(target) && accounts.size >= MaximumXAccountsPerGuild)
				return "commands/social:addXLimitReached" as const;

			await transaction.guildSocialSubscription.create(createInput);
			return null;
		});
	});

	if (createdResult.isErr()) {
		logFailure("store the subscription", createdResult.unwrapErr());
		return err("commands/social:addFailedDatabase");
	}

	const creationError = createdResult.unwrap();
	if (creationError) return err(creationError);
	return ok({ displayName });
}

/** Removes a subscription and, in the same breath, a source nothing follows anymore. */
export function removeSocialSubscription(
	key: SocialSubscriptionKey,
): Promise<Result<void, unknown>> {
	return Result.fromAsync(async () => {
		await container.prisma.guildSocialSubscription.delete({
			where: { guildId_channelId_sourceId: key },
			select: null,
		});
		await deleteOrphanedSources([key.sourceId]);
	});
}

export function resetGuildSocialSubscriptions(
	subscriptions: readonly GuildSocialSubscriptionWithSource[],
): Promise<Result<void, unknown>> {
	return Result.fromAsync(async () => {
		await Promise.all(
			subscriptions.map(({ guildId, channelId, sourceId }) =>
				container.prisma.guildSocialSubscription.delete({
					where: {
						guildId_channelId_sourceId: { guildId, channelId, sourceId },
					},
					select: null,
				}),
			),
		);
		await deleteOrphanedSources(subscriptions.map((sub) => sub.sourceId));
	});
}

/**
 * Posts the newest item of a source, through the same path a real notification takes, so a
 * success proves a real one would arrive.
 */
export async function testSocialSubscription(
	subscription: GuildSocialSubscriptionWithSource,
	notice: string,
): Promise<Result<void, TestSocialSubscriptionError>> {
	const { source } = subscription;
	const provider = getSocialProvider(source.provider);
	if (!provider?.getAuthRequirements().satisfied) {
		return err("providerNotConfigured");
	}

	const target = await socialDelivery.prepare(
		subscription.guildId,
		subscription.channelId,
	);
	if (target.isErr()) return err(target.unwrapErr());

	const channel = target.unwrap();
	const latest = await readLatestItems(provider, source);
	if (latest.isErr()) return err(latest.unwrapErr());

	// A preview is still a post: it must not show a channel what the channel would never receive.
	const channelIsNsfw = isNsfwChannel(channel);
	const item = latest.unwrap().find((entry) => channelIsNsfw || !entry.isNsfw);
	if (!item) return err("noItems");

	return socialDelivery.send(channel, {
		provider,
		item,
		source,
		message: subscription.message,
		notice,
	});
}

async function readLatestItems(
	provider: SocialProvider,
	source: SocialSource,
): Promise<Result<SocialItem[], "targetUnreachable">> {
	const result = await callProvider<FetchOutcome, ProviderFailure>(
		() => provider.fetchLatest(source.target, null),
		{ _tag: "Unavailable" },
	);
	if (result.isErr()) {
		logFailure(`read ${source.target}`, result.unwrapErr());
		return err("targetUnreachable");
	}

	const outcome = result.unwrap();
	return ok(outcome._tag === "Items" ? outcome.items : []);
}

/**
 * A provider should return its failures, but this runs on a member's command: one that throws
 * anyway must end in a reply, or the member is left looking at "thinking" forever.
 */
async function callProvider<T, E>(
	call: () => Promise<Result<T, E>>,
	failure: E,
): Promise<Result<T, E>> {
	try {
		return await call();
	} catch (error) {
		logFailure("call a provider", error);
		return err(failure);
	}
}

async function checkGuildLimit(
	guildId: bigint,
): Promise<AddSocialSubscriptionError | null> {
	const countResult = await Result.fromAsync(() =>
		container.prisma.guildSocialSubscription.count({
			where: {
				guildId,
			},
		}),
	);
	if (countResult.isErr()) {
		logFailure("count the guild subscriptions", countResult.unwrapErr());
		return "commands/social:addFailedDatabase";
	}

	return countResult.unwrap() >= MaximumSocialSubscriptionsPerGuild
		? "commands/social:addLimitReached"
		: null;
}

/**
 * Best effort. The poller ignores a source nobody follows, so one left behind is harmless, and
 * this is meant to fail when another guild subscribes to the source at the same moment.
 */
async function deleteOrphanedSources(sourceIds: readonly bigint[]) {
	const result = await Result.fromAsync(() =>
		container.prisma.socialSource.deleteMany({
			where: { id: { in: [...sourceIds] }, subscriptions: { none: {} } },
		}),
	);
	result.inspectErr((error) =>
		container.logger.debug("[social-subscriptions] Kept a source", error),
	);
}

function toStoredFilters(filters: SocialFilters) {
	return cast<Prisma.InputJsonValue>(filters);
}

function logFailure(action: string, error: ProviderFailure | unknown) {
	container.logger.error(`[social-subscriptions] Failed to ${action}`, error);
}
