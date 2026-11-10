// oxlint-disable no-await-in-loop -- each worker checks its sources one at a time on purpose
import type { GuildSocialSubscription } from "#lib/setup/prisma";
import type { SocialDelivery } from "#social/notifications";
import type {
	FetchOutcome,
	ProviderFailure,
	SocialItem,
	SocialProvider,
} from "#social/provider";
import type { SocialSourceWithSubscriptions, SocialStore } from "#social/store";
import { SocialProviderName } from "#generated/prisma";
import { evaluateItem, parseSocialFilters } from "#social/filters";
import { isNsfwChannel, parseItemUrl } from "#social/notifications";
import { MaximumBackoff, planNextCheck } from "#social/schedule";
import { findFreshItems, mergeSeenIds, toSeenId } from "#social/seen";
import { NotificationDeliveryError } from "#utils/notificationDelivery";
import { RateLimitManager } from "@sapphire/ratelimits";
import { err, Result } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";

/** How often the poller looks for due sources. A source's own interval is what paces it. */
export const PollInterval = Time.Second * 30;
/** How many due sources one provider picks up per tick. */
export const PollBatchSize = 100;
/** How long a claimed source stays out of the queue if the process dies before recording it. */
export const ClaimLease = Time.Minute * 5;
/** Renewed well before it runs out, since one Discord request can take a while. */
const ClaimRenewalInterval = ClaimLease / 2;
/** How long every source of a provider rests after its credentials are refused. */
export const AuthFailurePause = Time.Minute * 15;
/**
 * Burst cap per channel and check. A feed that republishes its archive must not bury the channel,
 * and what is kept is the newest, which is what a reader wants from a burst.
 */
export const MaximumNotificationsPerCheck = 10;
/**
 * How long an item stays worth retrying when it could not be delivered. Long enough to ride out a
 * Discord outage, short enough that fixing a channel a week later does not post last week.
 */
export const RetryWindow = Time.Day;

export interface SocialPollerOptions {
	providers: readonly SocialProvider[];
	store: SocialStore;
	delivery: SocialDelivery;
	logger: {
		debug(...values: unknown[]): void;
		warn(...values: unknown[]): void;
		error(...values: unknown[]): void;
	};
	now?: () => number;
	random?: () => number;
}

/**
 * Checks every due source and posts what is new.
 *
 * Each provider runs on its own loop, so a slow or failing one only ever delays itself. Every
 * source is checked inside a `Result`, so one bad target cannot end its provider's loop either.
 */
export class SocialPoller {
	readonly #options: SocialPollerOptions;
	readonly #now: () => number;
	readonly #random: () => number;
	readonly #runs = new Map<SocialProviderName, Promise<void>>();
	/** Keyed by limit and window, so providers declaring the same one share its scopes. */
	readonly #budgets = new Map<string, RateLimitManager>();
	readonly #pausedScopes = new Map<string, number>();
	/** When an item first failed to go out, so it can be retried without being retried forever. */
	readonly #refusals = new Map<string, number>();
	#timer: NodeJS.Timeout | null = null;

	public constructor(options: SocialPollerOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#random = options.random ?? Math.random;
	}

	public start() {
		this.#timer ??= setInterval(() => void this.tick(), PollInterval);
		this.#timer.unref();
		void this.tick();
	}

	public stop() {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
	}

	/** Starts a run for every idle provider and resolves once they are all done. */
	public async tick() {
		this.#forgetOldRefusals();

		const runs = this.#options.providers
			.filter((provider) => provider.getAuthRequirements().satisfied)
			.map((provider) => {
				const running = this.#runs.get(provider.name);
				if (running) return running;

				const run = this.#runProvider(provider).finally(() =>
					this.#runs.delete(provider.name),
				);
				this.#runs.set(provider.name, run);
				return run;
			});

		await Promise.all(runs);
	}

	async #runProvider(provider: SocialProvider) {
		const { store, logger } = this.#options;
		const dueResult = await Result.fromAsync(() =>
			store.findDueSources(provider.name, new Date(this.#now()), PollBatchSize),
		);
		if (dueResult.isErr()) {
			logger.error(
				`[social-poller] Could not list the due ${provider.name} sources`,
				dueResult.unwrapErr(),
			);
			return;
		}

		const queue = dueResult.unwrap();
		const worker = async () => {
			for (
				let source = queue.shift();
				source !== undefined;
				source = queue.shift()
			) {
				const { id } = source;
				const result = await Result.fromAsync(() =>
					this.#checkSource(provider, source!),
				);
				if (result.isErr()) {
					logger.error(
						`[social-poller] The check of ${provider.name} source ${id} failed`,
						result.unwrapErr(),
					);
				}
			}
		};

		await Promise.all(Array.from({ length: provider.concurrency }, worker));
	}

	async #checkSource(
		provider: SocialProvider,
		source: SocialSourceWithSubscriptions,
	) {
		const { store } = this.#options;
		const now = this.#now();
		const scope = provider.rateLimitScope(source.target);

		const resumeAt = this.#takeBudget(provider, scope, now);
		if (resumeAt !== null) {
			// Moved out of the way instead of left due: the queue is oldest first, so sources waiting
			// on one slow host would otherwise fill every batch and starve the whole provider.
			if (
				source.provider === SocialProviderName.YouTube &&
				source.checkRequested
			)
				await store.deferSource(source.id, new Date(resumeAt), true);
			else await store.deferSource(source.id, new Date(resumeAt));
			return;
		}

		let lease = new Date(now + ClaimLease);
		if (!(await store.claimSource(source, lease))) return;

		// A slow delivery can outlive the lease. Once another process takes the source over, carrying
		// on would post what that process is posting and overwrite what it stores.
		let renewedAt = now;
		const holdsClaim = async () => {
			const time = this.#now();
			if (time - renewedAt < ClaimRenewalInterval) return true;

			const renewed = new Date(time + ClaimLease);
			if (!(await store.renewClaim(source.id, lease, renewed))) return false;

			lease = renewed;
			renewedAt = time;
			return true;
		};

		const result = await this.#fetch(provider, source);
		const value = result.isOk() ? result.unwrap() : null;
		const failure = result.isErr()
			? result.unwrapErr()
			: value?._tag === "Items"
				? (value.failure ?? null)
				: null;
		if (failure) this.#pauseScope(failure, scope, provider, now);

		const plan = planNextCheck({
			intervalMs: provider.checkIntervalMs,
			failure,
			failureCount: source.failureCount,
			now,
			random: this.#random(),
		});
		const lastCheckedAt = new Date(now);
		if (value?._tag !== "Items") {
			await store.recordCheck(source.id, lease, { ...plan, lastCheckedAt });
			return;
		}

		// Nothing can be posted without a link, so such an item would only fail on every check.
		const items = value.items.filter(({ url }) => parseItemUrl(url) !== null);

		let needsFullFetch = false;
		for (const subscription of source.subscriptions) {
			if (!(await holdsClaim())) return;

			// oxlint-disable-next-line no-loop-func -- awaited before the next iteration
			const pending = await Result.fromAsync(() =>
				this.#notify(provider, source, subscription, items, holdsClaim),
			);
			if (pending.isErr()) {
				this.#options.logger.error(
					`[social-poller] Could not notify channel ${subscription.channelId} about source ${source.id}`,
					pending.unwrapErr(),
				);
			}

			needsFullFetch ||= pending.unwrapOr(true);
		}

		if (!(await holdsClaim())) return;

		// What is still pending is only fetched again if the next request is not conditional.
		await store.recordCheck(source.id, lease, {
			...plan,
			lastCheckedAt,
			state: needsFullFetch ? null : value.state,
		});
	}

	/** A provider that throws costs this one check, it does not reach its loop. */
	async #fetch(
		provider: SocialProvider,
		source: SocialSourceWithSubscriptions,
	): Promise<Result<FetchOutcome, ProviderFailure>> {
		try {
			return await provider.fetchLatest(source.target, source.state, {
				checkRequested: source.checkRequested,
			});
		} catch (error) {
			this.#options.logger.error(
				`[social-poller] ${provider.name} threw while fetching source ${source.id}`,
				error,
			);
			return err({ _tag: "Unavailable" });
		}
	}

	/** Spends one request of the budget, or answers when to come back for it. */
	#takeBudget(provider: SocialProvider, scope: string, now: number) {
		const spread = this.#random() * PollInterval;
		const pausedUntil = this.#pausedScopes.get(scope) ?? 0;
		if (pausedUntil > now) return pausedUntil + spread;
		this.#pausedScopes.delete(scope);
		if (provider.rateLimitOwner === "provider") return null;

		const { windowMs, limit } = provider.rateLimit;
		const key = `${limit}/${windowMs}`;
		let budget = this.#budgets.get(key);
		if (!budget) {
			budget = new RateLimitManager(windowMs, limit);
			this.#budgets.set(key, budget);
		}

		const bucket = budget.acquire(scope);
		if (bucket.limited) return now + bucket.remainingTime + spread;

		bucket.consume();
		return null;
	}

	/** The limit and the credentials belong to the whole scope, not to the source that hit them. */
	#pauseScope(
		failure: ProviderFailure,
		scope: string,
		provider: SocialProvider,
		now: number,
	) {
		if (failure._tag === "RateLimited") {
			const wait = failure.retryAfterMs ?? provider.checkIntervalMs;
			this.#pausedScopes.set(scope, now + Math.min(wait, MaximumBackoff));
		} else if (failure._tag === "AuthFailed") {
			this.#pausedScopes.set(scope, now + AuthFailurePause);
		}
	}

	/** Answers whether items were left pending for a later check. */
	async #notify(
		provider: SocialProvider,
		source: SocialSourceWithSubscriptions,
		subscription: GuildSocialSubscription,
		items: readonly SocialItem[],
		holdsClaim: () => Promise<boolean>,
	) {
		const { store, delivery, logger } = this.#options;
		const fresh = findFreshItems(
			items,
			subscription.lastNotifiedId
				? [...subscription.seenItemIds, subscription.lastNotifiedId]
				: subscription.seenItemIds,
		);
		if (fresh.length === 0) return false;

		const key = {
			guildId: subscription.guildId,
			channelId: subscription.channelId,
			sourceId: subscription.sourceId,
		};
		const now = this.#now();

		const target = await delivery.prepare(key.guildId, key.channelId);
		if (target.isErr()) {
			// Discord being down looks exactly like a broken channel from here, so the items stay
			// pending for a while. `/settings` reports the reason in the meantime.
			const expired = fresh.filter(
				(item) =>
					isPastRetryWindow(item, now) ||
					!this.#shouldRetry(getAttemptKey(source, key, item), now),
			);
			await store.updateSubscription(key, {
				seenItemIds: mergeSeenIds(subscription.seenItemIds, expired),
				deliveryError: toStoredError(target.unwrapErr()),
			});
			return expired.length < fresh.length;
		}

		const channel = target.unwrap();
		const filters = parseSocialFilters(subscription.filters);
		const context = {
			channelIsNsfw: isNsfwChannel(channel),
			now,
			subscribedAt: subscription.createdAt,
		};

		const verdicts = fresh.map((item) => ({
			item,
			verdict: evaluateItem(item, filters, context),
		}));
		const deliverable = verdicts
			.filter(({ verdict }) => verdict === "deliver")
			.map(({ item }) => item);
		const accepted = deliverable.slice(-MaximumNotificationsPerCheck);
		if (accepted.length < deliverable.length) {
			logger.warn(
				`[social-poller] Dropped ${deliverable.length - accepted.length} older item(s) of source ${source.id} for channel ${key.channelId}`,
			);
		}

		const waiting = verdicts.filter(({ verdict }) => verdict === "wait");
		const settled = fresh.filter(
			(item) =>
				!accepted.includes(item) &&
				!waiting.some((entry) => entry.item === item),
		);

		let seenItemIds = mergeSeenIds(subscription.seenItemIds, settled);
		if (settled.length > 0) {
			// Getting here proves the channel works, even if every item was filtered out.
			await store.updateSubscription(key, { seenItemIds, deliveryError: null });
		}

		let pending = waiting.length > 0;
		for (const item of accepted) {
			if (!(await holdsClaim())) return true;

			const sent = await delivery.send(channel, {
				provider,
				item,
				source,
				message: subscription.message,
			});
			const deliveryError = sent.isErr()
				? toStoredError(sent.unwrapErr())
				: null;

			const attempt = getAttemptKey(source, key, item);
			if (sent.isErr() && this.#shouldRetry(attempt, now)) {
				pending = true;
				await store.updateSubscription(key, { deliveryError });
				continue;
			}

			this.#refusals.delete(attempt);
			seenItemIds = mergeSeenIds(seenItemIds, [item]);
			await store.updateSubscription(key, {
				seenItemIds,
				deliveryError,
				...(sent.isOk() ? { lastNotifiedId: toSeenId(item) } : {}),
			});
		}

		return pending;
	}

	#shouldRetry(attempt: string, now: number) {
		const firstRefusedAt = this.#refusals.get(attempt) ?? now;
		this.#refusals.set(attempt, firstRefusedAt);
		return now - firstRefusedAt < RetryWindow;
	}

	/** An item can leave its feed before it is retried, and nothing else would clear its entry. */
	#forgetOldRefusals() {
		const cutoff = this.#now() - RetryWindow * 2;
		for (const [attempt, firstRefusedAt] of this.#refusals) {
			if (firstRefusedAt < cutoff) this.#refusals.delete(attempt);
		}
	}
}

function getAttemptKey(
	source: SocialSourceWithSubscriptions,
	{ channelId }: { channelId: bigint },
	item: SocialItem,
) {
	return `${source.id}:${channelId}:${toSeenId(item)}`;
}

function isPastRetryWindow(item: SocialItem, now: number) {
	return (
		item.publishedAt !== null && now - item.publishedAt.getTime() >= RetryWindow
	);
}

function toStoredError(error: NotificationDeliveryError) {
	return NotificationDeliveryError[
		error
	] as keyof typeof NotificationDeliveryError;
}
