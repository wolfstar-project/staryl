import type { ProviderFailure, FetchOutcome } from "#social/provider";
import type {
	ResolvedTarget,
	SocialItem,
	SocialProvider,
	TargetError,
} from "#social/provider";
import type { Result } from "@sapphire/result";
import { SocialColors } from "#common/constants";
import { SocialProviderName } from "#generated/prisma";
import { readConnectedJson } from "#social/connectedHttp";
import { parseFeed } from "#social/feed";
import {
	sendRequest,
	SocialUserAgent,
	toHttpFailure,
	parseRetryAfter,
} from "#social/http";
import {
	createSocialCard,
	parseImageUrl,
	parseItemUrl,
} from "#social/notifications";
import {
	getCallbackToken,
	getChannelTopic,
	isWebSubConfigured,
} from "#social/websub";
import { err, ok, Result as Results } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";
import { container } from "@wolfstar/http-framework";

const FeedOrigin = "https://www.youtube.com/feeds/videos.xml?channel_id=";
const ChannelsApi = "https://www.googleapis.com/youtube/v3/channels";
const HubUrl = "https://pubsubhubbub.appspot.com/subscribe";

const ChannelPattern =
	/^(?:(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/channel\/)?(UC[\w-]{22})(?:[/?#].*)?$/;
const HandlePattern =
	/^(?:(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/)?@([\w.-]{3,30})(?:[/?#].*)?$/;

const LeaseSeconds = Time.Day / Time.Second;
/** Well inside the lease, because a hub is free to grant a shorter one than was asked for. */
const LeaseRenewalInterval = Time.Hour;

export interface YouTubeProviderOptions {
	fetch?: typeof fetch;
	env?: Record<string, string | undefined>;
	now?: () => number;
}

/**
 * Notifies about new videos of a YouTube channel, reading its official Atom feed and Data API v3 metadata.
 *
 * Scheduled checks only renew WebSub. A baseline or authenticated push reads videos;
 * the Data API supplies metadata and the duration used by the documented Shorts approximation.
 */
export function createYouTubeProvider(
	options: YouTubeProviderOptions = {},
): SocialProvider {
	const { env = process.env, now = Date.now } = options;
	const request = options.fetch ?? fetch;

	async function resolveHandle(
		handle: string,
	): Promise<Result<string, TargetError>> {
		// Turning a handle into a channel needs the Data API; reading the channel page instead would
		// be the scraping YouTube's terms forbid.
		const key = env.YOUTUBE_API_KEY;
		if (!key) return err({ _tag: "InvalidTarget" });

		const query = new URLSearchParams({
			part: "id",
			forHandle: `@${handle}`,
			key,
		});
		const response = await sendRequest(request, `${ChannelsApi}?${query}`);
		if (response.isErr() || !response.unwrap().ok) {
			return err({ _tag: "TargetUnreachable" });
		}

		const body = (await response
			.unwrap()
			.json()
			.catch(() => null)) as { items?: { id?: string }[] } | null;
		const id = body?.items?.[0]?.id;
		return id ? ok(id) : err({ _tag: "TargetNotFound" });
	}

	async function readChannel(
		channelId: string,
	): Promise<Result<ResolvedTarget, TargetError>> {
		const response = await sendRequest(request, `${FeedOrigin}${channelId}`, {
			headers: { "user-agent": SocialUserAgent },
		});
		if (response.isErr()) return err({ _tag: "TargetUnreachable" });

		const answer = response.unwrap();
		if (answer.status === 404) return err({ _tag: "TargetNotFound" });
		if (!answer.ok) return err({ _tag: "TargetUnreachable" });

		const feed = parseFeed(await answer.text());
		if (feed === null) return err({ _tag: "TargetUnreachable" });

		return ok({ target: channelId, displayName: feed.title ?? channelId });
	}

	function buildCallback(channelId: string) {
		const callback = new URL(env.YOUTUBE_WEBSUB_CALLBACK!);
		callback.searchParams.set(
			"token",
			getCallbackToken(env.YOUTUBE_WEBSUB_SECRET!, channelId),
		);
		return callback.href;
	}

	async function renewLease(
		channelId: string,
	): Promise<Result<void, ProviderFailure>> {
		if (!isWebSubConfigured(env)) return err({ _tag: "Unavailable" });
		const where = { provider: SocialProviderName.YouTube, target: channelId };
		const source = await container.prisma.socialSource.findUnique({
			where: { provider_target: where },
			select: { websubExpiresAt: true, websubRequestedAt: true },
		});
		if (!source) return err({ _tag: "TargetUnavailable" });
		if (
			source.websubExpiresAt &&
			source.websubExpiresAt.getTime() - now() > LeaseRenewalInterval
		)
			return ok(undefined);

		const requestedAt = source.websubRequestedAt?.getTime();
		if (requestedAt !== undefined && now() - requestedAt < Time.Minute * 5)
			return ok(undefined);
		const verificationTimedOut = requestedAt !== undefined;
		const requestStartedAt = new Date(now());
		await container.prisma.socialSource.updateMany({
			where,
			data: { websubRequestedAt: requestStartedAt },
		});

		const response = await sendRequest(request, HubUrl, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				"hub.callback": buildCallback(channelId),
				"hub.lease_seconds": String(LeaseSeconds),
				"hub.mode": "subscribe",
				"hub.secret": env.YOUTUBE_WEBSUB_SECRET!,
				"hub.topic": getChannelTopic(channelId),
				"hub.verify": "async",
			}),
		});
		const clearPending = () =>
			container.prisma.socialSource.updateMany({
				where: { ...where, websubRequestedAt: requestStartedAt },
				data: { websubRequestedAt: null },
			});
		if (response.isErr()) {
			await clearPending();
			return err(response.unwrapErr());
		}
		const answer = response.unwrap();
		if (!answer.ok) {
			await clearPending();
			return err(
				answer.status === 401 || answer.status === 403
					? { _tag: "Unavailable" }
					: toHttpFailure(answer.status, answer.headers.get("retry-after")),
			);
		}
		return verificationTimedOut ? err({ _tag: "Unavailable" }) : ok(undefined);
	}

	async function enrichItems(
		items: SocialItem[],
	): Promise<
		Result<{ items: SocialItem[]; incomplete: boolean }, ProviderFailure>
	> {
		if (items.length === 0) return ok({ items: [], incomplete: false });
		const ids = items.map((item) => item.id.replace(/^yt:video:/, ""));
		const response = await readConnectedJson<{
			items: {
				id: string;
				snippet: {
					title: string;
					description: string;
					thumbnails?: { high?: { url: string } };
				};
				contentDetails: { duration: string };
			}[];
		}>(
			request,
			`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ key: env.YOUTUBE_API_KEY!, part: "snippet,contentDetails", id: ids.join(",") })}`,
			{},
			classifyYouTubeFailure,
		);
		if (response.isErr()) return err(response.unwrapErr());
		if (!Array.isArray(response.unwrap().items))
			return err({ _tag: "InvalidResponse" });
		let incomplete = false;
		const enriched = items.flatMap((item) => {
			const video = response
				.unwrap()
				.items.find((entry) => entry.id === item.id.replace(/^yt:video:/, ""));
			if (!video) {
				// Fresh uploads may reach the feed before the Data API index. Older deleted videos must not keep a source pending forever.
				if (item.publishedAt && now() - item.publishedAt.getTime() < Time.Hour)
					incomplete = true;
				return [];
			}
			const duration = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
				video.contentDetails.duration,
			);
			const seconds = duration
				? Number(duration[1] ?? 0) * 3600 +
					Number(duration[2] ?? 0) * 60 +
					Number(duration[3] ?? 0)
				: null;
			return [
				{
					...item,
					title: video.snippet.title,
					text: video.snippet.description,
					imageUrl:
						parseImageUrl(video.snippet.thumbnails?.high?.url) ?? item.imageUrl,
					isShort:
						item.isShort || (seconds !== null && seconds > 0 && seconds <= 180),
				},
			];
		});
		return ok({ items: enriched, incomplete });
	}

	return {
		name: SocialProviderName.YouTube,
		// Maintenance wakes early enough to renew even a shortened hub grant.
		checkIntervalMs: Time.Minute * 10,
		concurrency: 4,
		rateLimit: { limit: 60, windowMs: Time.Minute },
		supportedFilters: new Set(["includeKeywords", "excludeKeywords", "shorts"]),
		rateLimitScope: () => "youtube",
		getAuthRequirements: () => ({
			variables: [
				"YOUTUBE_API_KEY",
				"YOUTUBE_WEBSUB_CALLBACK",
				"YOUTUBE_WEBSUB_SECRET",
			],
			satisfied: Boolean(env.YOUTUBE_API_KEY) && isWebSubConfigured(env),
		}),
		onSubscribed: renewLease,

		async validateTarget(input) {
			const channelId = ChannelPattern.exec(input)?.[1];
			if (channelId) return readChannel(channelId);

			const handle = HandlePattern.exec(input)?.[1];
			if (!handle) return err({ _tag: "InvalidTarget" });

			const resolved = await resolveHandle(handle);
			if (resolved.isErr()) return err(resolved.unwrapErr());
			return readChannel(resolved.unwrap());
		},

		async fetchLatest(
			target,
			state,
			context,
		): Promise<Result<FetchOutcome, ProviderFailure>> {
			let maintenanceFailure: ProviderFailure | undefined;
			if (context) {
				const renewed = await renewLease(target);
				if (renewed.isErr()) maintenanceFailure = renewed.unwrapErr();
				if (!context.checkRequested && state !== null)
					return maintenanceFailure
						? err(maintenanceFailure)
						: ok({ _tag: "NotModified" });
			}
			const response = await sendRequest(request, `${FeedOrigin}${target}`, {
				headers: { "user-agent": SocialUserAgent },
			});
			if (response.isErr()) return err(response.unwrapErr());

			const answer = response.unwrap();
			if (!answer.ok) {
				// The feed is public, so a refusal here says nothing about any credentials.
				return err(
					answer.status === 401 || answer.status === 403
						? { _tag: "Unavailable" }
						: toHttpFailure(answer.status, answer.headers.get("retry-after")),
				);
			}

			const feed = parseFeed(await answer.text());
			if (feed === null) return err({ _tag: "InvalidResponse" });

			const items = feed.entries.flatMap((entry): SocialItem[] => {
				const url = parseItemUrl(entry.url);
				if (url === null) return [];

				return [
					{
						...entry,
						url,
						authorAvatarUrl: null,
						imageUrl: parseImageUrl(entry.imageUrl),
						// The feed has no field for it, but it links a Short to its own player.
						isShort: url.includes("/shorts/"),
					},
				];
			});

			const enriched = await enrichItems(items);
			return enriched.isErr()
				? err(enriched.unwrapErr())
				: ok({
						_tag: "Items",
						items: enriched.unwrap().items,
						state: enriched.unwrap().incomplete ? null : { baselineRead: true },
						...(maintenanceFailure ? { failure: maintenanceFailure } : {}),
					});
		},

		formatNotification(item, source, t) {
			return createSocialCard(item, {
				accentColor: SocialColors.YouTube,
				heading: t(
					item.isShort
						? "events/social:youtubeHeadingShort"
						: "events/social:youtubeHeading",
					{ name: source.displayName },
				),
				footer: t("events/social:youtubeFooter"),
				linkLabel: t("events/social:watchVideo"),
			});
		},
	};
}

/** Quota exhaustion is retryable and must not ask operators to replace valid credentials. */
async function classifyYouTubeFailure(
	response: Response,
): Promise<ProviderFailure> {
	const parsed = await Results.fromAsync(() => response.json());
	const body = parsed.unwrapOr(null) as {
		error?: { errors?: { reason?: string }[] };
	} | null;
	const reasons = Array.isArray(body?.error?.errors) ? body.error.errors : [];
	if (
		reasons.some((error) =>
			[
				"quotaExceeded",
				"dailyLimitExceeded",
				"dailyLimitExceededUnreg",
				"rateLimitExceeded",
				"userRateLimitExceeded",
			].includes(error.reason ?? ""),
		)
	)
		return {
			_tag: "RateLimited",
			retryAfterMs:
				parseRetryAfter(response.headers.get("retry-after")) ?? Time.Hour,
		};
	return toHttpFailure(response.status, response.headers.get("retry-after"));
}
