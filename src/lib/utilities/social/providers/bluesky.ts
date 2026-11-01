import type {
	ProviderFailure,
	SocialItem,
	SocialProvider,
} from "#social/provider";
import type { Result } from "@sapphire/result";
import { SocialColors } from "#common/constants";
import { SocialProviderName } from "#generated/prisma";
import { sendRequest, SocialUserAgent, toHttpFailure } from "#social/http";
import {
	createSocialCard,
	parseImageUrl,
	parseItemUrl,
} from "#social/notifications";
import { err, ok } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";

const ApiOrigin = "https://public.api.bsky.app/xrpc";
const FeedSize = 30;
const ProfileUrlPattern = /^https?:\/\/bsky\.app\/profile\/([^/?#]+)/i;
const IdentifierPattern =
	/^(?:did:[a-z]+:[\w.:%-]+|[a-z\d-]+(?:\.[a-z\d-]+)+)$/i;
/** Set by an account that asked not to be shown to people who are logged out. */
const LoggedOutOptOutLabel = "!no-unauthenticated";
/** The moderation labels that mark adult content on the Bluesky network. */
const AdultLabels = new Set(["porn", "sexual", "nudity", "graphic-media"]);

interface BlueskyLabel {
	val: string;
}

interface BlueskyAuthor {
	did: string;
	handle: string;
	displayName?: string;
	avatar?: string;
	labels?: BlueskyLabel[];
}

interface BlueskyEmbed {
	images?: { fullsize?: string }[];
	thumbnail?: string;
	external?: { thumb?: string };
	media?: BlueskyEmbed;
}

interface BlueskyFeedEntry {
	post: {
		uri: string;
		author: BlueskyAuthor;
		record: { text?: string; createdAt?: string; reply?: unknown };
		embed?: BlueskyEmbed;
		labels?: BlueskyLabel[];
		indexedAt?: string;
	};
	reason?: { $type?: string; indexedAt?: string };
}

/**
 * Follows a Bluesky account through the public AppView, which serves public content without an
 * account. The target is the account's DID: a handle can change, a DID cannot.
 */
export function createBlueskyProvider(
	request: typeof fetch = fetch,
): SocialProvider {
	async function get<T>(
		method: string,
		query: Record<string, string>,
	): Promise<Result<T, ProviderFailure>> {
		const url = `${ApiOrigin}/${method}?${new URLSearchParams(query)}`;
		const response = await sendRequest(request, url, {
			headers: { "user-agent": SocialUserAgent },
		});
		if (response.isErr()) return err(response.unwrapErr());

		const answer = response.unwrap();
		// The XRPC API answers 400 for an account that does not exist or is suspended.
		if (answer.status === 400) return err({ _tag: "TargetUnavailable" });
		if (!answer.ok) {
			return err(
				toHttpFailure(answer.status, answer.headers.get("retry-after")),
			);
		}

		const body = (await answer.json().catch(() => null)) as T | null;
		return body === null ? err({ _tag: "InvalidResponse" }) : ok(body);
	}

	return {
		name: SocialProviderName.Bluesky,
		checkIntervalMs: Time.Minute * 3,
		concurrency: 4,
		rateLimit: { limit: 300, windowMs: Time.Minute * 5 },
		supportedFilters: new Set([
			"includeKeywords",
			"excludeKeywords",
			"excludeReplies",
			"excludeReposts",
		]),
		rateLimitScope: () => "bluesky",
		getAuthRequirements: () => ({ variables: [], satisfied: true }),

		async validateTarget(input) {
			const actor = parseActor(input);
			if (actor === null) return err({ _tag: "InvalidTarget" });

			const result = await get<BlueskyAuthor>("app.bsky.actor.getProfile", {
				actor,
			});
			if (result.isErr()) {
				return err(
					result.unwrapErr()._tag === "TargetUnavailable"
						? { _tag: "TargetNotFound" }
						: { _tag: "TargetUnreachable" },
				);
			}

			const profile = result.unwrap();
			if (hasOptedOut(profile)) return err({ _tag: "TargetNotFound" });

			return ok({
				target: profile.did,
				displayName: profile.displayName || `@${profile.handle}`,
			});
		},

		async fetchLatest(target) {
			const result = await get<{ feed?: BlueskyFeedEntry[] }>(
				"app.bsky.feed.getAuthorFeed",
				{
					actor: target,
					limit: String(FeedSize),
					filter: "posts_with_replies",
				},
			);
			if (result.isErr()) return err(result.unwrapErr());

			const { feed } = result.unwrap();
			if (!Array.isArray(feed)) return err({ _tag: "InvalidResponse" });

			return ok({ _tag: "Items", items: feed.flatMap(toItem), state: null });
		},

		formatNotification(item, source, t) {
			return createSocialCard(item, {
				accentColor: SocialColors.Bluesky,
				heading: t("events/social:blueskyHeading", {
					name: item.authorName ?? source.displayName,
				}),
				footer: t("events/social:blueskyFooter"),
				linkLabel: t("events/social:openPost"),
			});
		},
	};
}

function parseActor(input: string) {
	const fromUrl = ProfileUrlPattern.exec(input)?.[1];
	const actor = (fromUrl ?? input).replace(/^@/, "");

	// A bare name is what people say for the default domain.
	const candidate = /^[a-z\d-]+$/i.test(actor) ? `${actor}.bsky.social` : actor;
	return IdentifierPattern.test(candidate) ? candidate : null;
}

function hasOptedOut(author: BlueskyAuthor) {
	return (author.labels ?? []).some(({ val }) => val === LoggedOutOptOutLabel);
}

function toItem({ post, reason }: BlueskyFeedEntry): SocialItem[] {
	const { author, record, embed } = post;
	const recordKey = post.uri.split("/").at(-1);
	const url = parseItemUrl(
		`https://bsky.app/profile/${author.handle}/post/${recordKey}`,
	);
	if (url === null || hasOptedOut(author)) return [];

	const isRepost = reason?.$type === "app.bsky.feed.defs#reasonRepost";
	// A repost is dated by the repost: an old post shared today is news today.
	const date = isRepost
		? (reason?.indexedAt ?? post.indexedAt)
		: record.createdAt;
	return [
		{
			// A repost is a new event about an old post, so it cannot share the post's id.
			id: isRepost ? `repost:${post.uri}` : post.uri,
			url,
			title: null,
			text: record.text || null,
			authorName: author.displayName || `@${author.handle}`,
			authorAvatarUrl: parseImageUrl(author.avatar),
			imageUrl: readImage(embed),
			publishedAt: date ? new Date(date) : null,
			isReply: Boolean(record.reply),
			isRepost,
			isNsfw: (post.labels ?? []).some(({ val }) => AdultLabels.has(val)),
		},
	];
}

function readImage(embed: BlueskyEmbed | undefined): string | null {
	if (!embed) return null;

	return (
		parseImageUrl(embed.images?.[0]?.fullsize) ??
		parseImageUrl(embed.thumbnail) ??
		parseImageUrl(embed.external?.thumb) ??
		readImage(embed.media)
	);
}
