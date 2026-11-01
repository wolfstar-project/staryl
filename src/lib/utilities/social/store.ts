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
	 * Takes a due source for this check by moving `nextCheckAt` forward. Answers `false` when it is
	 * no longer due, so two processes never check the same source, and a process that dies
	 * mid-check only delays it until the lease runs out.
	 */
	claimSource(
		id: bigint,
		expectedNextCheckAt: Date,
		leaseUntil: Date,
	): Promise<boolean>;
	recordCheck(id: bigint, record: CheckRecord): Promise<void>;
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
					nextCheckAt: { lte: now },
					subscriptions: { some: {} },
				},
				include: { subscriptions: true },
				orderBy: { nextCheckAt: "asc" },
				take: limit,
			});
		},
		async claimSource(id, expectedNextCheckAt, leaseUntil) {
			const { count } = await prisma.socialSource.updateMany({
				where: { id, nextCheckAt: expectedNextCheckAt },
				data: { nextCheckAt: leaseUntil },
			});
			return count === 1;
		},
		async recordCheck(id, { state, ...record }) {
			await prisma.socialSource.updateMany({
				where: { id },
				data: {
					...record,
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
