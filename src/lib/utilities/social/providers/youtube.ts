import type { Prisma } from "#lib/setup/prisma";
import type {
	ResolvedTarget,
	SocialItem,
	SocialProvider,
	TargetError,
} from "#social/provider";
import type { Result } from "@sapphire/result";
import { SocialColors } from "#common/constants";
import { SocialProviderName } from "#generated/prisma";
import { parseFeed } from "#social/feed";
import { sendRequest, SocialUserAgent, toHttpFailure } from "#social/http";
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
import { err, ok } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";
import { isObject } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";

const FeedOrigin = "https://www.youtube.com/feeds/videos.xml?channel_id=";
const ChannelsApi = "https://www.googleapis.com/youtube/v3/channels";
const HubUrl = "https://pubsubhubbub.appspot.com/subscribe";

const ChannelPattern =
	/^(?:(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/channel\/)?(UC[\w-]{22})(?:[/?#].*)?$/;
const HandlePattern =
	/^(?:(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/)?@([\w.-]{3,30})(?:[/?#].*)?$/;

const LeaseSeconds = (Time.Day * 10) / Time.Second;
/** Well inside the lease, because a hub is free to grant a shorter one than was asked for. */
const LeaseRenewalInterval = Time.Day * 3;

interface LeaseState {
	leaseRequestedAt?: number;
}

export interface YouTubeProviderOptions {
	fetch?: typeof fetch;
	env?: Record<string, string | undefined>;
	now?: () => number;
}

/**
 * Notifies about new videos of a YouTube channel, reading the channel's official Atom feed.
 *
 * The feed needs no key and costs no Data API quota. When `YOUTUBE_WEBSUB_*` is configured, YouTube
 * also pushes a hint as soon as a video goes up (see `#social/websub`), which only makes the check
 * happen sooner; without it the same check still finds everything, a few minutes later.
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

	/** Answers the state to keep. A failed attempt keeps the old one, so the next check retries. */
	async function renewLease(
		channelId: string,
		state: Prisma.JsonValue | null,
	): Promise<LeaseState> {
		const previous = isObject(state) ? (state as LeaseState) : {};
		if (!isWebSubConfigured(env)) return {};

		const requestedAt = previous.leaseRequestedAt ?? 0;
		if (now() - requestedAt < LeaseRenewalInterval) return previous;

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

		if (response.isOk() && response.unwrap().ok) {
			return { leaseRequestedAt: now() };
		}

		container.logger.warn(
			`[youtube] The hub refused the subscription of ${channelId}, checks carry on without pushes`,
		);
		return previous;
	}

	return {
		name: SocialProviderName.YouTube,
		// The same with or without pushes: a hub accepting a subscription does not mean it can reach
		// us, and a wrong callback must not quietly make notifications slower.
		checkIntervalMs: Time.Minute * 10,
		concurrency: 4,
		rateLimit: { limit: 60, windowMs: Time.Minute },
		supportedFilters: new Set(["includeKeywords", "excludeKeywords", "shorts"]),
		rateLimitScope: () => "youtube",
		getAuthRequirements: () => ({ variables: [], satisfied: true }),

		async validateTarget(input) {
			const channelId = ChannelPattern.exec(input)?.[1];
			if (channelId) return readChannel(channelId);

			const handle = HandlePattern.exec(input)?.[1];
			if (!handle) return err({ _tag: "InvalidTarget" });

			const resolved = await resolveHandle(handle);
			if (resolved.isErr()) return err(resolved.unwrapErr());
			return readChannel(resolved.unwrap());
		},

		async fetchLatest(target, state) {
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

			return ok({
				_tag: "Items",
				items,
				state: { ...(await renewLease(target, state)) },
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
