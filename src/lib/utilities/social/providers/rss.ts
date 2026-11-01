import type { Prisma } from "#lib/setup/prisma";
import type {
	FetchOutcome,
	ProviderFailure,
	ResolvedTarget,
	SocialItem,
	SocialProvider,
	TargetError,
} from "#social/provider";
import type {
	PublicFetcher,
	PublicFetchError,
	PublicResponse,
} from "#social/publicFetch";
import type { Result } from "@sapphire/result";
import { SocialColors } from "#common/constants";
import { SocialProviderName } from "#generated/prisma";
import { findFeedLink, parseFeed } from "#social/feed";
import { SocialUserAgent, toHttpFailure } from "#social/http";
import {
	createSocialCard,
	parseImageUrl,
	parseItemUrl,
} from "#social/notifications";
import { fetchPublicUrl } from "#social/publicFetch";
import { err, ok } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";
import { isObject } from "@sapphire/utilities";

interface FeedState {
	etag?: string;
	lastModified?: string;
}

/**
 * Follows any RSS or Atom feed. It needs no account or key, which is why it doubles as the
 * reference implementation of `SocialProvider`.
 */
export function createRssProvider(
	fetchUrl: PublicFetcher = fetchPublicUrl,
): SocialProvider {
	const request = (url: string, headers: Record<string, string> = {}) =>
		fetchUrl(url, {
			headers: {
				accept:
					"application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
				"user-agent": SocialUserAgent,
				...headers,
			},
		});

	return {
		name: SocialProviderName.Rss,
		checkIntervalMs: Time.Minute * 10,
		concurrency: 8,
		// Per remote host: many feeds can live on one site, and it should not feel that as a burst.
		rateLimit: { limit: 30, windowMs: Time.Minute * 5 },
		supportedFilters: new Set(["includeKeywords", "excludeKeywords"]),
		rateLimitScope: (target) => new URL(target).hostname,
		getAuthRequirements: () => ({ variables: [], satisfied: true }),

		async validateTarget(input) {
			const url = /^[a-z][a-z\d+.-]*:\/\//i.test(input)
				? input
				: `https://${input}`;

			const page = await request(url);
			if (page.isErr()) return err(toTargetError(page.unwrapErr()));

			const pageResponse = page.unwrap();
			const direct = readFeed(pageResponse);
			if (direct.isOk() || direct.unwrapErr()._tag !== "TargetUnsupported") {
				return direct;
			}

			const link = findFeedLink(pageResponse.body, pageResponse.url);
			if (link === null) return direct;

			const feed = await request(link);
			if (feed.isErr()) return err(toTargetError(feed.unwrapErr()));
			return readFeed(feed.unwrap());
		},

		async fetchLatest(target, state) {
			const result = await request(target, toConditionalHeaders(state));
			if (result.isErr()) return err(toProviderFailure(result.unwrapErr()));

			return toFetchOutcome(result.unwrap());
		},

		formatNotification(item, source, t) {
			return createSocialCard(item, {
				accentColor: SocialColors.Rss,
				heading: t("events/social:rssHeading", { name: source.displayName }),
				footer: t("events/social:rssFooter"),
				linkLabel: t("events/social:openArticle"),
			});
		},
	};
}

function readFeed(
	response: PublicResponse,
): Result<ResolvedTarget, TargetError> {
	if (response.status === 404 || response.status === 410) {
		return err({ _tag: "TargetNotFound" });
	}
	if (response.status < 200 || response.status >= 300) {
		return err({ _tag: "TargetUnreachable" });
	}

	const feed = parseFeed(response.body);
	if (feed === null) return err({ _tag: "TargetUnsupported" });

	return ok({
		target: response.url,
		displayName: feed.title ?? new URL(response.url).hostname,
	});
}

function toFetchOutcome(
	response: PublicResponse,
): Result<FetchOutcome, ProviderFailure> {
	if (response.status === 304) return ok({ _tag: "NotModified" });
	if (response.status < 200 || response.status >= 300) {
		// A feed behind a login is a target problem, there are no credentials of ours to blame.
		if (response.status === 401 || response.status === 403) {
			return err({ _tag: "TargetUnavailable" });
		}

		return err(
			toHttpFailure(response.status, readHeader(response, "retry-after")),
		);
	}

	const feed = parseFeed(response.body);
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
			},
		];
	});

	const state: FeedState = {
		etag: readHeader(response, "etag"),
		lastModified: readHeader(response, "last-modified"),
	};
	return ok({
		_tag: "Items",
		items,
		state: state.etag || state.lastModified ? { ...state } : null,
	});
}

function toConditionalHeaders(state: Prisma.JsonValue | null) {
	const headers: Record<string, string> = {};
	if (!isObject(state)) return headers;

	const { etag, lastModified } = state as FeedState;
	if (typeof etag === "string") headers["if-none-match"] = etag;
	if (typeof lastModified === "string") {
		headers["if-modified-since"] = lastModified;
	}
	return headers;
}

function readHeader(response: PublicResponse, name: string) {
	const value = response.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function toTargetError(error: PublicFetchError): TargetError {
	switch (error._tag) {
		case "InvalidUrl":
			return { _tag: "InvalidTarget" };
		case "ForbiddenAddress":
			return { _tag: "TargetBlocked" };
		case "TooLarge":
			return { _tag: "TargetUnsupported" };
		default:
			return { _tag: "TargetUnreachable" };
	}
}

function toProviderFailure(error: PublicFetchError): ProviderFailure {
	switch (error._tag) {
		case "InvalidUrl":
		case "ForbiddenAddress":
			return { _tag: "TargetUnavailable" };
		case "TooLarge":
			return { _tag: "InvalidResponse" };
		default:
			return { _tag: "Unavailable" };
	}
}
