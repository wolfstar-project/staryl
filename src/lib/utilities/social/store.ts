import type { PrismaClient } from "#generated/prisma";
import type {
	GuildSocialSubscription,
	Prisma,
	SocialDeliveryError,
	SocialProviderName,
	SocialSource,
} from "#lib/setup/prisma";
import type { CheckPlan } from "#social/schedule";
import { Prisma as PrismaNamespace } from "#generated/prisma";

export type SocialSourceWithSubscriptions = SocialSource & {
	subscriptions: GuildSocialSubscription[];
};

export type SubscriptionKey = Pick<
	GuildSocialSubscription,
	"guildId" | "channelId" | "sourceId"
>;

export interface SubscriptionUpdate {
	seenItemIds?: string[];
	deliveryError?: SocialDeliveryError | null;
}

export interface CheckRecord extends CheckPlan {
	lastCheckedAt: Date;
	/** Left out to keep the stored state; `null` clears it. */
	state?: Prisma.InputJsonValue | null;
}

/** The persistence the poller needs, kept narrow so a test can back it with plain arrays. */
export interface SocialStore {
	findDueSources(
		provider: SocialProviderName,
		now: Date,
		limit: number,
	): Promise<SocialSourceWithSubscriptions[]>;
	/**
	 * Takes a due source for this check. Answers `false` when another process got there first, and a
	 * process that dies mid-check only delays the source until its lease runs out.
	 *
	 * `lastCheckedAt` is compared too because a released claim looks like one never taken: without
	 * it, a process holding an old read could check again a source another one just finished.
	 */
	claimSource(
		source: Pick<SocialSource, "id" | "claimedUntil" | "lastCheckedAt">,
		leaseUntil: Date,
	): Promise<boolean>;
	/** Extends a held claim, answering `false` when the source now belongs to another process. */
	renewClaim(id: bigint, lease: Date, leaseUntil: Date): Promise<boolean>;
	/** Puts a source off without counting it as checked. */
	deferSource(id: bigint, until: Date): Promise<void>;
	/** Stores a check and releases the claim. Does nothing for a claim that was lost in the meantime. */
	recordCheck(id: bigint, lease: Date, record: CheckRecord): Promise<void>;
	updateSubscription(
		key: SubscriptionKey,
		update: SubscriptionUpdate,
	): Promise<void>;
}

export function createSocialStore(prisma: PrismaClient): SocialStore {
	return {
		findDueSources(provider, now, limit) {
			return prisma.socialSource.findMany({
				where: {
					provider,
					subscriptions: { some: {} },
					AND: [
						{ OR: [{ nextCheckAt: { lte: now } }, { checkRequested: true }] },
						{ OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }] },
					],
				},
				include: { subscriptions: true },
				orderBy: [{ checkRequested: "desc" }, { nextCheckAt: "asc" }],
				take: limit,
			});
		},
		async claimSource({ id, claimedUntil, lastCheckedAt }, leaseUntil) {
			const { count } = await prisma.socialSource.updateMany({
				where: { id, claimedUntil, lastCheckedAt },
				data: { claimedUntil: leaseUntil, checkRequested: false },
			});
			return count === 1;
		},
		async renewClaim(id, lease, leaseUntil) {
			const { count } = await prisma.socialSource.updateMany({
				where: { id, claimedUntil: lease },
				data: { claimedUntil: leaseUntil },
			});
			return count === 1;
		},
		async deferSource(id, until) {
			await prisma.socialSource.updateMany({
				where: { id },
				data: { nextCheckAt: until, checkRequested: false },
			});
		},
		async recordCheck(id, lease, { state, ...record }) {
			await prisma.socialSource.updateMany({
				where: { id, claimedUntil: lease },
				data: {
					...record,
					claimedUntil: null,
					...(state === undefined
						? {}
						: { state: state ?? PrismaNamespace.DbNull }),
				},
			});
		},
		async updateSubscription(key, update) {
			// `updateMany` because a member can remove the subscription while it is being checked.
			await prisma.guildSocialSubscription.updateMany({
				where: key,
				data: update,
			});
		},
	};
}
