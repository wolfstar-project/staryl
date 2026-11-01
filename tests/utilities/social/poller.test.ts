import type {
	FetchOutcome,
	ProviderFailure,
	SocialItem,
	SocialProvider,
} from "#social/provider";
import type {
	CheckRecord,
	SocialSourceWithSubscriptions,
	SocialStore,
	SubscriptionKey,
	SubscriptionUpdate,
} from "#social/store";
import type { NotificationTarget } from "#utils/notificationDelivery";
import type { Result } from "@sapphire/result";
import { SocialProviderName } from "#generated/prisma";
import {
	AuthFailurePause,
	ClaimLease,
	MaximumNotificationsPerCheck,
	PollBatchSize,
	RetryWindow,
	SocialPoller,
} from "#social/poller";
import { MaximumFetchedItems, MaximumSeenItems } from "#social/seen";
import { NotificationDeliveryError } from "#utils/notificationDelivery";
import { err, ok } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Now = Date.UTC(2026, 10, 1, 12);
const CheckInterval = Time.Minute * 10;

function makeItem(id: string, overrides: Partial<SocialItem> = {}): SocialItem {
	return {
		id,
		url: `https://example.com/${id}`,
		title: `Item ${id}`,
		text: null,
		authorName: null,
		authorAvatarUrl: null,
		imageUrl: null,
		publishedAt: new Date(Now),
		...overrides,
	};
}

function makeSource(
	overrides: Partial<SocialSourceWithSubscriptions> = {},
	subscriptionOverrides: Partial<
		SocialSourceWithSubscriptions["subscriptions"][number]
	> = {},
): SocialSourceWithSubscriptions {
	return {
		id: 1n,
		provider: SocialProviderName.Rss,
		target: "https://example.com/feed",
		displayName: "Example",
		state: null,
		lastFailure: null,
		failureCount: 0,
		lastCheckedAt: null,
		nextCheckAt: new Date(Now - 1),
		claimedUntil: null,
		checkRequested: false,
		subscriptions: [
			{
				guildId: 10n,
				channelId: 20n,
				sourceId: 1n,
				message: null,
				filters: {},
				seenItemIds: [],
				deliveryError: null,
				createdAt: new Date(0),
				...subscriptionOverrides,
			},
		],
		...overrides,
	};
}

function makeProvider(
	fetchLatest: SocialProvider["fetchLatest"],
	overrides: Partial<SocialProvider> = {},
): SocialProvider {
	return {
		name: SocialProviderName.Rss,
		checkIntervalMs: CheckInterval,
		concurrency: 2,
		rateLimit: { limit: 100, windowMs: Time.Minute },
		supportedFilters: new Set(),
		rateLimitScope: () => "scope",
		getAuthRequirements: () => ({ variables: [], satisfied: true }),
		validateTarget: vi.fn(),
		fetchLatest,
		formatNotification: vi.fn(),
		...overrides,
	};
}

function items(...list: SocialItem[]): Result<FetchOutcome, ProviderFailure> {
	return ok({ _tag: "Items", items: list, state: { etag: "next" } });
}

/** An in-memory stand-in for the database, recording what the poller persisted. */
function makeStore(sources: SocialSourceWithSubscriptions[]) {
	const checks: { id: bigint; record: CheckRecord }[] = [];
	const updates: { key: SubscriptionKey; update: SubscriptionUpdate }[] = [];
	const store: SocialStore = {
		findDueSources: vi.fn(async () => sources.splice(0)),
		claimSource: vi.fn(async () => true),
		renewClaim: vi.fn(async () => true),
		deferSource: vi.fn(async () => undefined),
		recordCheck: vi.fn(async (id, _lease, record) => {
			checks.push({ id, record });
		}),
		updateSubscription: vi.fn(async (key, update) => {
			updates.push({ key, update });
		}),
	};
	return { store, checks, updates };
}

function makeDelivery(channel: Partial<NotificationTarget["channel"]> = {}) {
	const posted: string[] = [];
	const target = { channel: { id: "20", ...channel }, t: vi.fn() };
	return {
		posted,
		delivery: {
			prepare: vi.fn(async () => ok(target as unknown as NotificationTarget)),
			send: vi.fn(
				async (
					_: NotificationTarget,
					{ item }: { item: SocialItem },
				): Promise<Result<void, NotificationDeliveryError>> => {
					posted.push(item.id);
					return ok();
				},
			),
		},
	};
}

const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makePoller(
	providers: SocialProvider[],
	store: SocialStore,
	delivery: ReturnType<typeof makeDelivery>["delivery"],
) {
	return new SocialPoller({
		providers,
		store,
		delivery,
		logger,
		now: () => Now,
		random: () => 0,
	});
}

describe("SocialPoller", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("posts unseen items oldest first and records them", async () => {
		const { store, updates, checks } = makeStore([makeSource()]);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () =>
			items(makeItem("new"), makeItem("old")),
		);

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual(["old", "new"]);
		expect(updates.at(-1)!.update.seenItemIds).toEqual(["old", "new"]);
		expect(checks[0].record).toMatchObject({
			failureCount: 0,
			lastFailure: null,
			state: { etag: "next" },
		});
	});

	it("never posts an item twice", async () => {
		const source = makeSource({}, { seenItemIds: ["old"] });
		const { store } = makeStore([source]);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () =>
			items(makeItem("new"), makeItem("old")),
		);

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual(["new"]);
	});

	it("records each post before the next, so a crash cannot repeat what went out", async () => {
		const { store, updates } = makeStore([makeSource()]);
		const { delivery } = makeDelivery();
		const provider = makeProvider(async () =>
			items(makeItem("b"), makeItem("a")),
		);

		await makePoller([provider], store, delivery).tick();

		expect(updates.map(({ update }) => update.seenItemIds)).toEqual([
			["a"],
			["a", "b"],
		]);
	});

	it.each([
		["a huge id", "x".repeat(5000)],
		["an id with a NUL byte", "a\0b"],
	])("stores a digest for %s, and still recognizes it", async (_, id) => {
		const first = makeStore([makeSource()]);
		const { delivery, posted } = makeDelivery();
		const url = "https://example.com/1";
		const provider = makeProvider(async () => items(makeItem(id, { url })));

		await makePoller([provider], first.store, delivery).tick();

		const seenItemIds = first.updates.at(-1)!.update.seenItemIds!;
		expect(seenItemIds[0]).toMatch(/^sha256:[\da-f]{64}$/);

		const second = makeStore([makeSource({}, { seenItemIds })]);
		await makePoller([provider], second.store, delivery).tick();
		expect(posted).toEqual([id]);
	});

	it("gives every channel its own view of the source", async () => {
		const source = makeSource();
		source.subscriptions.push({
			...source.subscriptions[0],
			channelId: 21n,
			filters: { includeKeywords: ["nothing"] },
		});
		const { store } = makeStore([source]);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () => items(makeItem("a")));

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual(["a"]);
	});

	it("keeps an item unseen while a score threshold is pending, and refetches in full", async () => {
		const source = makeSource({}, { filters: { minimumScore: 10 } });
		const { store, updates, checks } = makeStore([source]);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () =>
			items(makeItem("a", { score: 1 })),
		);

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual([]);
		expect(updates).toEqual([]);
		expect(checks[0].record.state).toBeNull();
	});

	it("respects the NSFW mark of the channel", async () => {
		const { store } = makeStore([makeSource()]);
		const { delivery, posted } = makeDelivery({ nsfw: true } as never);
		const provider = makeProvider(async () =>
			items(makeItem("a", { isNsfw: true })),
		);

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual(["a"]);
	});

	it("keeps only the newest items of a burst", async () => {
		const burst = Array.from(
			{ length: MaximumNotificationsPerCheck + 2 },
			(_, i) => makeItem(`${MaximumNotificationsPerCheck + 2 - i}`),
		);
		const { store, updates } = makeStore([makeSource()]);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () => items(...burst));

		await makePoller([provider], store, delivery).tick();

		expect(posted).toHaveLength(MaximumNotificationsPerCheck);
		expect(posted.at(-1)).toBe(`${MaximumNotificationsPerCheck + 2}`);
		expect(updates.at(-1)!.update.seenItemIds).toHaveLength(burst.length);
	});

	it("bounds the stored ids", async () => {
		const seenItemIds = Array.from(
			{ length: MaximumSeenItems },
			(_, i) => `${i}`,
		);
		const { store, updates } = makeStore([makeSource({}, { seenItemIds })]);
		const { delivery } = makeDelivery();
		const provider = makeProvider(async () => items(makeItem("a")));

		await makePoller([provider], store, delivery).tick();

		const stored = updates.at(-1)!.update.seenItemIds!;
		expect(stored).toHaveLength(MaximumSeenItems);
		expect(stored.at(-1)).toBe("a");
	});

	it("keeps recent items pending when the channel cannot be reached, and says why", async () => {
		const { store, updates, checks } = makeStore([makeSource()]);
		const { delivery, posted } = makeDelivery();
		delivery.prepare.mockResolvedValue(
			err(NotificationDeliveryError.MissingPermissions) as never,
		);
		const provider = makeProvider(async () => items(makeItem("a")));

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual([]);
		expect(updates[0].update).toEqual({
			seenItemIds: [],
			deliveryError: "MissingPermissions",
		});
		expect(checks[0].record.state).toBeNull();
	});

	it("posts what was held back once Discord is reachable again", async () => {
		const { delivery, posted } = makeDelivery();
		delivery.prepare.mockResolvedValueOnce(
			err(NotificationDeliveryError.GuildUnavailable) as never,
		);
		const provider = makeProvider(async () => items(makeItem("a")));

		const outage = makeStore([makeSource()]);
		await makePoller([provider], outage.store, delivery).tick();
		const recovered = makeStore([makeSource()]);
		await makePoller([provider], recovered.store, delivery).tick();

		expect(posted).toEqual(["a"]);
	});

	it("lets go of items too old to be worth posting after an outage", async () => {
		const { store, updates } = makeStore([makeSource()]);
		const { delivery } = makeDelivery();
		delivery.prepare.mockResolvedValue(
			err(NotificationDeliveryError.ChannelNotFound) as never,
		);
		const publishedAt = new Date(Now - RetryWindow);
		const provider = makeProvider(async () =>
			items(makeItem("new"), makeItem("old", { publishedAt })),
		);

		await makePoller([provider], store, delivery).tick();

		expect(updates[0].update.seenItemIds).toEqual(["old"]);
	});

	it("clears the delivery error once a post goes through", async () => {
		const source = makeSource({}, { deliveryError: "MissingPermissions" });
		const { store, updates } = makeStore([source]);
		const { delivery } = makeDelivery();
		const provider = makeProvider(async () => items(makeItem("a")));

		await makePoller([provider], store, delivery).tick();

		expect(updates.at(-1)!.update.deliveryError).toBeNull();
	});

	it("gives up on an undated item too, so conditional requests can resume", async () => {
		const { delivery } = makeDelivery();
		delivery.prepare.mockResolvedValue(
			err(NotificationDeliveryError.ChannelNotFound) as never,
		);
		const provider = makeProvider(async () =>
			items(makeItem("undated", { publishedAt: null })),
		);
		let now = Now;
		const { store, updates, checks } = makeStore([]);
		const poller = new SocialPoller({
			providers: [provider],
			store,
			delivery,
			logger,
			now: () => now,
		});

		vi.mocked(store.findDueSources).mockResolvedValueOnce([makeSource()]);
		await poller.tick();
		expect(checks.at(-1)!.record.state).toBeNull();

		now += RetryWindow;
		vi.mocked(store.findDueSources).mockResolvedValueOnce([makeSource()]);
		await poller.tick();

		expect(updates.at(-1)!.update.seenItemIds).toEqual(["undated"]);
		expect(checks.at(-1)!.record.state).toEqual({ etag: "next" });
	});

	it("clears an old delivery error even when nothing ends up posted", async () => {
		const source = makeSource(
			{},
			{
				deliveryError: "MissingPermissions",
				filters: { includeKeywords: ["nothing"] },
			},
		);
		const { store, updates } = makeStore([source]);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () => items(makeItem("a")));

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual([]);
		expect(updates[0].update.deliveryError).toBeNull();
	});

	it("retries an item Discord refuses, and gives up on it after a day", async () => {
		const { delivery, posted } = makeDelivery();
		delivery.send.mockResolvedValue(err(NotificationDeliveryError.SendFailed));
		const provider = makeProvider(async () => items(makeItem("a")));
		let now = Now;
		const poller = makeStore([]);
		const shared = new SocialPoller({
			providers: [provider],
			store: poller.store,
			delivery,
			logger,
			now: () => now,
		});

		vi.mocked(poller.store.findDueSources).mockResolvedValueOnce([
			makeSource(),
		]);
		await shared.tick();
		expect(poller.updates.at(-1)!.update).toEqual({
			deliveryError: "SendFailed",
		});
		expect(poller.checks.at(-1)!.record.state).toBeNull();

		now += RetryWindow - 1;
		vi.mocked(poller.store.findDueSources).mockResolvedValueOnce([
			makeSource(),
		]);
		await shared.tick();
		expect(poller.updates.at(-1)!.update).toEqual({
			deliveryError: "SendFailed",
		});

		now += 1;
		vi.mocked(poller.store.findDueSources).mockResolvedValueOnce([
			makeSource(),
		]);
		await shared.tick();
		expect(poller.updates.at(-1)!.update).toEqual({
			seenItemIds: ["a"],
			deliveryError: "SendFailed",
		});

		expect(posted).toEqual([]);
	});

	it("does not let one refused item hold back the rest", async () => {
		const { store } = makeStore([makeSource()]);
		const { delivery, posted } = makeDelivery();
		const send = delivery.send.getMockImplementation()!;
		delivery.send.mockImplementation(async (target, options) =>
			options.item.id === "poison"
				? err(NotificationDeliveryError.SendFailed)
				: send(target, options),
		);
		const provider = makeProvider(async () =>
			items(makeItem("good"), makeItem("poison")),
		);

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual(["good"]);
	});

	it("does not let one failing subscription stop the others", async () => {
		const source = makeSource();
		source.subscriptions.push({ ...source.subscriptions[0], channelId: 21n });
		const { store, checks } = makeStore([source]);
		vi.mocked(store.updateSubscription).mockRejectedValueOnce(
			new Error("down"),
		);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () => items(makeItem("a")));

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual(["a", "a"]);
		expect(checks[0].record.state).toBeNull();
	});

	it("does not touch a source another process claimed first", async () => {
		const { store, checks } = makeStore([makeSource()]);
		vi.mocked(store.claimSource).mockResolvedValue(false);
		const { delivery } = makeDelivery();
		const fetchLatest = vi.fn();

		await makePoller([makeProvider(fetchLatest)], store, delivery).tick();

		expect(fetchLatest).not.toHaveBeenCalled();
		expect(checks).toEqual([]);
	});

	it("claims a source for the length of the lease", async () => {
		const { store } = makeStore([makeSource()]);
		const { delivery } = makeDelivery();
		const provider = makeProvider(async () => items());

		await makePoller([provider], store, delivery).tick();

		expect(store.claimSource).toHaveBeenCalledWith(
			expect.objectContaining({ id: 1n, claimedUntil: null }),
			new Date(Now + ClaimLease),
		);
	});

	it("releases the claim it holds when recording the check", async () => {
		const { store } = makeStore([makeSource()]);
		const { delivery } = makeDelivery();
		const provider = makeProvider(async () => items());

		await makePoller([provider], store, delivery).tick();

		expect(vi.mocked(store.recordCheck).mock.calls[0][1]).toEqual(
			new Date(Now + ClaimLease),
		);
	});

	describe("during a slow delivery", () => {
		function makeSlowPoller(
			store: SocialStore,
			delivery: ReturnType<typeof makeDelivery>["delivery"],
			provider: SocialProvider,
		) {
			let now = Now;
			const send = delivery.send.getMockImplementation()!;
			delivery.send.mockImplementation(async (target, options) => {
				now += ClaimLease;
				return send(target, options);
			});
			return new SocialPoller({
				providers: [provider],
				store,
				delivery,
				logger,
				now: () => now,
				random: () => 0,
			});
		}

		it("keeps extending its claim, and records with the latest one", async () => {
			const { store } = makeStore([makeSource()]);
			const { delivery, posted } = makeDelivery();
			const provider = makeProvider(async () =>
				items(makeItem("b"), makeItem("a")),
			);

			await makeSlowPoller(store, delivery, provider).tick();

			expect(posted).toEqual(["a", "b"]);
			const renewals = vi.mocked(store.renewClaim).mock.calls;
			expect(renewals[0].slice(1)).toEqual([
				new Date(Now + ClaimLease),
				new Date(Now + ClaimLease * 2),
			]);
			expect(vi.mocked(store.recordCheck).mock.calls[0][1]).toEqual(
				renewals.at(-1)![2],
			);
		});

		it("stops as soon as another process has taken the source over", async () => {
			const { store, checks } = makeStore([makeSource()]);
			vi.mocked(store.renewClaim).mockResolvedValue(false);
			const { delivery, posted } = makeDelivery();
			const provider = makeProvider(async () =>
				items(makeItem("b"), makeItem("a")),
			);

			await makeSlowPoller(store, delivery, provider).tick();

			expect(posted).toEqual(["a"]);
			expect(checks).toEqual([]);
		});
	});

	it("keeps the stored state when nothing changed", async () => {
		const { store, checks } = makeStore([makeSource()]);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () => ok({ _tag: "NotModified" }));

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual([]);
		expect(checks[0].record).not.toHaveProperty("state");
		expect(checks[0].record.lastCheckedAt).toEqual(new Date(Now));
	});

	it("records a failure and backs the source off", async () => {
		const { store, checks } = makeStore([makeSource({ failureCount: 1 })]);
		const { delivery } = makeDelivery();
		const provider = makeProvider(async () => err({ _tag: "Unavailable" }));

		await makePoller([provider], store, delivery).tick();

		expect(checks[0].record).toMatchObject({
			failureCount: 2,
			lastFailure: "Unavailable",
			nextCheckAt: new Date(Now + CheckInterval * 4),
		});
	});

	it("treats a provider that throws as a failed check of that source alone", async () => {
		const sources = [
			makeSource({ id: 1n, target: "bad" }),
			makeSource({ id: 2n, target: "good" }),
		];
		const { store, checks } = makeStore(sources);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async (target) => {
			if (target === "bad") throw new Error("boom");
			return items(makeItem("a"));
		});

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual(["a"]);
		expect(checks.find(({ id }) => id === 1n)!.record.lastFailure).toBe(
			"Unavailable",
		);
		expect(checks.find(({ id }) => id === 2n)!.record.lastFailure).toBeNull();
	});

	it("does not let one provider's failure reach another", async () => {
		const { store } = makeStore([]);
		vi.mocked(store.findDueSources).mockImplementation(async (provider) => {
			if (String(provider) === "broken") throw new Error("database down");
			return [makeSource()];
		});
		const { delivery, posted } = makeDelivery();
		const broken = makeProvider(vi.fn(), {
			name: "broken" as SocialProviderName,
		});
		const healthy = makeProvider(async () => items(makeItem("a")));

		await makePoller([broken, healthy], store, delivery).tick();

		expect(posted).toEqual(["a"]);
		expect(logger.error).toHaveBeenCalledOnce();
	});

	it("does not let a slow provider delay the next tick of the others", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { store } = makeStore([]);
		vi.mocked(store.findDueSources).mockImplementation(async (provider) =>
			String(provider) === "slow" ? [makeSource({ id: 2n })] : [makeSource()],
		);
		const { delivery, posted } = makeDelivery();
		const slow = makeProvider(
			async () => {
				await blocked;
				return items();
			},
			{ name: "slow" as SocialProviderName },
		);
		let quickChecks = 0;
		const quick = makeProvider(async () => {
			quickChecks += 1;
			return items(makeItem(`quick-${quickChecks}`));
		});
		const poller = makePoller([slow, quick], store, delivery);

		const firstTick = poller.tick();
		await vi.waitFor(() => expect(posted).toContain("quick-1"));
		const secondTick = poller.tick();
		await vi.waitFor(() => expect(posted).toContain("quick-2"));

		release();
		await Promise.all([firstTick, secondTick]);
		expect(store.findDueSources).toHaveBeenCalledTimes(3);
	});

	it("skips a provider whose credentials are missing", async () => {
		const { store } = makeStore([makeSource()]);
		const { delivery } = makeDelivery();
		const provider = makeProvider(vi.fn(), {
			getAuthRequirements: () => ({
				variables: ["TOKEN"],
				satisfied: false,
			}),
		});

		await makePoller([provider], store, delivery).tick();

		expect(store.findDueSources).not.toHaveBeenCalled();
	});

	it("moves a source out of the queue when its budget is spent, without failing it", async () => {
		const sources = [makeSource({ id: 1n }), makeSource({ id: 2n })];
		const { store, checks } = makeStore(sources);
		const { delivery } = makeDelivery();
		const provider = makeProvider(async () => items(), {
			concurrency: 1,
			rateLimit: { limit: 1, windowMs: Time.Hour },
		});

		await makePoller([provider], store, delivery).tick();

		expect(checks.map(({ id }) => id)).toEqual([1n]);
		const [id, resumeAt] = vi.mocked(store.deferSource).mock.calls[0];
		expect(id).toBe(2n);
		expect(resumeAt.getTime()).toBeGreaterThan(Now + Time.Minute * 59);
	});

	it("pauses the whole scope after a rate limit", async () => {
		const sources = [makeSource({ id: 1n }), makeSource({ id: 2n })];
		const { store, checks } = makeStore(sources);
		const { delivery } = makeDelivery();
		const fetchLatest = vi.fn(async () =>
			err<ProviderFailure>({ _tag: "RateLimited", retryAfterMs: Time.Hour }),
		);
		const provider = makeProvider(fetchLatest, { concurrency: 1 });

		await makePoller([provider], store, delivery).tick();

		expect(fetchLatest).toHaveBeenCalledOnce();
		expect(checks).toHaveLength(1);
	});

	it("does not let sources of a paused host fill every batch", async () => {
		const stuck = Array.from({ length: PollBatchSize }, (_, index) =>
			makeSource({ id: BigInt(index), target: "stuck" }),
		);
		const queue = [...stuck, makeSource({ id: 1000n, target: "healthy" })];
		const { store } = makeStore([]);
		vi.mocked(store.findDueSources).mockImplementation(async (_, now, limit) =>
			queue.filter((source) => source.nextCheckAt <= now).slice(0, limit),
		);
		vi.mocked(store.deferSource).mockImplementation(async (id, until) => {
			queue.find((source) => source.id === id)!.nextCheckAt = until;
		});
		vi.mocked(store.recordCheck).mockImplementation(
			async (id, _lease, record) => {
				queue.find((source) => source.id === id)!.nextCheckAt =
					record.nextCheckAt;
			},
		);
		const { delivery } = makeDelivery();
		const fetched: string[] = [];
		const provider = makeProvider(
			async (target) => {
				fetched.push(target);
				return target === "stuck"
					? err({ _tag: "RateLimited", retryAfterMs: Time.Hour })
					: items();
			},
			{ concurrency: 1, rateLimitScope: (target) => target },
		);
		const poller = makePoller([provider], store, delivery);

		await poller.tick();
		await poller.tick();

		expect(fetched).toContain("healthy");
	});

	it("rests every source of a provider whose credentials were refused", async () => {
		const sources = [makeSource({ id: 1n }), makeSource({ id: 2n })];
		const { store } = makeStore(sources);
		const { delivery } = makeDelivery();
		const fetchLatest = vi.fn(async () =>
			err<ProviderFailure>({ _tag: "AuthFailed" }),
		);
		const provider = makeProvider(fetchLatest, { concurrency: 1 });

		await makePoller([provider], store, delivery).tick();

		expect(fetchLatest).toHaveBeenCalledOnce();
		const [, resumeAt] = vi.mocked(store.deferSource).mock.calls[0];
		expect(resumeAt.getTime()).toBeGreaterThanOrEqual(Now + AuthFailurePause);
	});

	it("shares a budget between providers declaring the same limit and scope", async () => {
		const { store } = makeStore([]);
		vi.mocked(store.findDueSources).mockImplementation(async () => [
			makeSource(),
		]);
		const { delivery } = makeDelivery();
		const fetchLatest = vi.fn(async () => items());
		const rateLimit = { limit: 1, windowMs: Time.Hour };
		const first = makeProvider(fetchLatest, { rateLimit });
		const second = makeProvider(fetchLatest, {
			rateLimit,
			name: "other" as SocialProviderName,
		});

		await makePoller([first, second], store, delivery).tick();

		expect(fetchLatest).toHaveBeenCalledOnce();
	});

	it("does not post an old item that slid back into the feed", async () => {
		const source = makeSource({}, { createdAt: new Date(Now) });
		const { store, updates } = makeStore([source]);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () =>
			items(makeItem("old", { publishedAt: new Date(Now - Time.Day) })),
		);

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual([]);
		expect(updates[0].update.seenItemIds).toEqual(["old"]);
	});

	it("skips an item with nothing to link to, without failing the others", async () => {
		const { store } = makeStore([makeSource()]);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () =>
			items(makeItem("good"), makeItem("bad", { url: "/relative" })),
		);

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual(["good"]);
	});

	it("posts an item listed twice in one fetch only once", async () => {
		const { store } = makeStore([makeSource()]);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () =>
			items(makeItem("a"), makeItem("a")),
		);

		await makePoller([provider], store, delivery).tick();

		expect(posted).toEqual(["a"]);
	});

	it("does not loop on a server that ignores the page size", async () => {
		const flood = Array.from({ length: MaximumSeenItems + 50 }, (_, index) =>
			makeItem(`${index}`),
		);
		const { delivery, posted } = makeDelivery();
		const provider = makeProvider(async () => items(...flood));

		let seenItemIds: string[] = [];
		for (let round = 0; round < 3; round += 1) {
			const { store, updates } = makeStore([makeSource({}, { seenItemIds })]);
			// oxlint-disable-next-line no-await-in-loop -- rounds build on each other
			await makePoller([provider], store, delivery).tick();
			seenItemIds = updates.at(-1)?.update.seenItemIds ?? seenItemIds;
		}

		expect(posted).toHaveLength(MaximumNotificationsPerCheck);
		expect(new Set(seenItemIds).size).toBe(MaximumFetchedItems);
	});
});
