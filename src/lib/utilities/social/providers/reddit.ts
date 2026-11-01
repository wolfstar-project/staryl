import type {
	ProviderFailure,
	SocialItem,
	SocialProvider,
} from "#social/provider";
import type { Result } from "@sapphire/result";
import { SocialColors } from "#common/constants";
import { SocialProviderName } from "#generated/prisma";
import { sendRequest, toHttpFailure } from "#social/http";
import {
	createSocialCard,
	parseImageUrl,
	parseItemUrl,
} from "#social/notifications";
import { err, ok } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";
import { isObject } from "@sapphire/utilities";

const ApiOrigin = "https://oauth.reddit.com";
const TokenUrl = "https://www.reddit.com/api/v1/access_token";
/** Renewed this early so a token cannot expire between the check and the request. */
const TokenMargin = Time.Minute;
/** Reddit's maximum. A post waiting on a score threshold is lost once it scrolls out of this. */
const ListingSize = 100;
const SubredditPattern =
	/^(?:(?:https?:\/\/)?(?:[\w-]+\.)?reddit\.com)?\/?(?:r\/)?(\w{2,21})\/?$/i;

const CredentialVariables = [
	"REDDIT_CLIENT_ID",
	"REDDIT_CLIENT_SECRET",
	"REDDIT_USERNAME",
] as const;

export interface RedditProviderOptions {
	fetch?: typeof fetch;
	env?: Record<string, string | undefined>;
	now?: () => number;
}

interface RedditPost {
	name: string;
	title: string;
	selftext?: string;
	author?: string;
	permalink: string;
	created_utc?: number;
	link_flair_text?: string | null;
	over_18?: boolean;
	score?: number;
	spoiler?: boolean;
	preview?: { images?: { source?: { url?: string } }[] };
}

/**
 * Follows a subreddit through Reddit's Data API.
 *
 * The Data API Terms require the OAuth token Reddit issued to the app, and an honest User-Agent.
 * The anonymous `.json` and `.rss` endpoints are not used for that reason, so this provider stays
 * off until credentials are configured.
 */
export function createRedditProvider(
	options: RedditProviderOptions = {},
): SocialProvider {
	const { env = process.env, now = Date.now } = options;
	const request = options.fetch ?? fetch;
	let token: { value: string; expiresAt: number } | null = null;

	const getUserAgent = () =>
		`linux:rocks.wolfstar.staryl:v${env.CLIENT_VERSION ?? "1.0.0"} (by /u/${env.REDDIT_USERNAME})`;

	async function fetchToken(): Promise<Result<string, ProviderFailure>> {
		if (token && token.expiresAt > now()) return ok(token.value);

		const credentials = Buffer.from(
			`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`,
		).toString("base64");
		const response = await sendRequest(request, TokenUrl, {
			method: "POST",
			headers: {
				authorization: `Basic ${credentials}`,
				"content-type": "application/x-www-form-urlencoded",
				"user-agent": getUserAgent(),
			},
			body: "grant_type=client_credentials",
		});
		if (response.isErr()) return err(response.unwrapErr());

		const answer = response.unwrap();
		if (!answer.ok) {
			return err(
				toHttpFailure(answer.status, answer.headers.get("retry-after")),
			);
		}

		const body = (await answer.json().catch(() => null)) as {
			access_token?: string;
			expires_in?: number;
		} | null;
		if (!body?.access_token) return err({ _tag: "AuthFailed" });

		token = {
			value: body.access_token,
			expiresAt: now() + (body.expires_in ?? 0) * Time.Second - TokenMargin,
		};
		return ok(token.value);
	}

	async function get(
		path: string,
		isRetry = false,
	): Promise<Result<unknown, ProviderFailure>> {
		const tokenResult = await fetchToken();
		if (tokenResult.isErr()) return err(tokenResult.unwrapErr());

		const response = await sendRequest(request, `${ApiOrigin}${path}`, {
			headers: {
				authorization: `bearer ${tokenResult.unwrap()}`,
				"user-agent": getUserAgent(),
			},
			// An unknown subreddit redirects to a search page instead of answering 404.
			redirect: "manual",
		});
		if (response.isErr()) return err(response.unwrapErr());

		const answer = response.unwrap();
		if (answer.status === 401 && !isRetry) {
			token = null;
			return get(path, true);
		}
		// 403 is a private or quarantined subreddit, which says nothing about our credentials.
		if (
			answer.status === 403 ||
			(answer.status >= 300 && answer.status < 400)
		) {
			return err({ _tag: "TargetUnavailable" });
		}
		if (!answer.ok) {
			return err(
				toHttpFailure(answer.status, answer.headers.get("retry-after")),
			);
		}

		const body = (await answer.json().catch(() => null)) as unknown;
		return body === null ? err({ _tag: "InvalidResponse" }) : ok(body);
	}

	return {
		name: SocialProviderName.Reddit,
		checkIntervalMs: Time.Minute * 5,
		concurrency: 2,
		rateLimit: { limit: 60, windowMs: Time.Minute },
		supportedFilters: new Set([
			"includeKeywords",
			"excludeKeywords",
			"flairs",
			"minimumScore",
		]),
		rateLimitScope: () => "reddit",

		getAuthRequirements: () => ({
			variables: CredentialVariables,
			satisfied: CredentialVariables.every((name) => Boolean(env[name])),
		}),

		async validateTarget(input) {
			const name = SubredditPattern.exec(input)?.[1];
			if (!name) return err({ _tag: "InvalidTarget" });

			const result = await get(`/r/${name}/about?raw_json=1`);
			if (result.isErr()) {
				return err(
					result.unwrapErr()._tag === "TargetUnavailable"
						? { _tag: "TargetNotFound" }
						: { _tag: "TargetUnreachable" },
				);
			}

			const about = result.unwrap() as {
				kind?: string;
				data?: { display_name?: string };
			};
			const displayName = about.data?.display_name;
			if (about.kind !== "t5" || !displayName) {
				return err({ _tag: "TargetNotFound" });
			}

			return ok({
				target: displayName.toLowerCase(),
				displayName: `r/${displayName}`,
			});
		},

		async fetchLatest(target) {
			const result = await get(
				`/r/${target}/new?limit=${ListingSize}&raw_json=1`,
			);
			if (result.isErr()) return err(result.unwrapErr());

			const listing = result.unwrap() as {
				data?: { children?: { data?: RedditPost }[] };
			};
			if (!Array.isArray(listing.data?.children)) {
				return err({ _tag: "InvalidResponse" });
			}

			return ok({
				_tag: "Items",
				items: listing.data.children.flatMap((child) =>
					isObject(child.data) ? toItem(child.data) : [],
				),
				state: null,
			});
		},

		formatNotification(item, source, t) {
			return createSocialCard(item, {
				accentColor: SocialColors.Reddit,
				heading: t("events/social:redditHeading", {
					name: source.displayName,
				}),
				footer: t("events/social:redditFooter"),
				linkLabel: t("events/social:openPost"),
			});
		},
	};
}

function toItem(post: RedditPost): SocialItem[] {
	const url = parseItemUrl(`https://www.reddit.com${post.permalink}`);
	if (!post.name || url === null) return [];

	return [
		{
			id: post.name,
			url,
			title: post.title,
			// A spoiler's text and picture would both give away what the tag is hiding.
			text: post.spoiler ? null : post.selftext || null,
			authorName: post.author ? `u/${post.author}` : null,
			authorAvatarUrl: null,
			imageUrl: post.spoiler
				? null
				: parseImageUrl(post.preview?.images?.[0]?.source?.url),
			publishedAt: post.created_utc
				? new Date(post.created_utc * Time.Second)
				: null,
			isNsfw: post.over_18 === true,
			flair: post.link_flair_text ?? null,
			score: post.score ?? 0,
		},
	];
}
