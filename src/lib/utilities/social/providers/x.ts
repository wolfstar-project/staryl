import type {
	SocialItem,
	SocialProvider,
	ProviderFailure,
} from "#social/provider";
import { createHmac, randomBytes } from "node:crypto";
import { SocialColors } from "#common/constants";
import { SocialProviderName } from "#generated/prisma";
import { sendRequest, toHttpFailure, SocialUserAgent } from "#social/http";
import { createSocialCard, parseImageUrl } from "#social/notifications";
import { RateLimitManager } from "@sapphire/ratelimits";
import { err, ok, Result } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";
import { isObject } from "@sapphire/utilities";

interface XUser {
	id: string;
	username: string;
	name: string;
	protected?: boolean;
	profile_image_url?: string;
}
interface XPost {
	id: string;
	text: string;
	created_at?: string;
	author_id?: string;
	referenced_tweets?: { type: string }[];
	attachments?: { media_keys?: string[] };
}
interface XResponse {
	data?: XPost[];
	meta?: { next_token?: string };
	includes?: {
		users?: XUser[];
		media?: { media_key: string; url?: string; preview_image_url?: string }[];
	};
}
const Variables = [
	"X_API_KEY",
	"X_API_SECRET",
	"X_ACCESS_TOKEN",
	"X_ACCESS_SECRET",
];
const encode = (value: string) =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

/** Official API only. The shared poller owns the budget, retry and delivery. */
export function createXProvider(
	options: {
		fetch?: typeof fetch;
		env?: Record<string, string | undefined>;
	} = {},
): SocialProvider {
	const { env = process.env, fetch: request = fetch } = options;
	const budget = new RateLimitManager(Time.Minute * 15, 15);
	async function read(url: URL): Promise<Result<Response, ProviderFailure>> {
		const bucket = budget.acquire("x");
		if (bucket.limited)
			return err({ _tag: "RateLimited", retryAfterMs: Time.Minute * 15 });
		bucket.consume();
		const oauth: Record<string, string> = {
			oauth_consumer_key: env.X_API_KEY!,
			oauth_token: env.X_ACCESS_TOKEN!,
			oauth_nonce: randomBytes(16).toString("hex"),
			oauth_timestamp: String(Math.floor(Date.now() / 1000)),
			oauth_signature_method: "HMAC-SHA1",
			oauth_version: "1.0",
		};
		const parameters = [...url.searchParams, ...Object.entries(oauth)]
			.map(([key, value]) => [encode(key), encode(value)])
			.toSorted(([a, b], [c, d]) =>
				a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0,
			)
			.map(([key, value]) => `${key}=${value}`)
			.join("&");
		oauth.oauth_signature = createHmac(
			"sha1",
			`${encode(env.X_API_SECRET!)}&${encode(env.X_ACCESS_SECRET!)}`,
		)
			.update(`GET&${encode(url.origin + url.pathname)}&${encode(parameters)}`)
			.digest("base64");
		const result = await sendRequest(request, url.href, {
			headers: {
				authorization: `OAuth ${Object.entries(oauth)
					.map(([key, value]) => `${encode(key)}="${encode(value)}"`)
					.join(", ")}`,
				"user-agent": SocialUserAgent,
			},
		});
		if (result.isErr()) return result;
		const response = result.unwrap();
		return response.ok
			? ok(response)
			: err(
					response.status === 403
						? { _tag: "TargetUnavailable" }
						: toHttpFailure(
								response.status,
								response.headers.get("retry-after"),
							),
				);
	}
	return {
		name: SocialProviderName.X,
		checkIntervalMs: Time.Minute * 15,
		concurrency: 1,
		rateLimit: { limit: 15, windowMs: Time.Minute * 15 },
		rateLimitScope: () => "x",
		supportedFilters: new Set([
			"includeKeywords",
			"excludeKeywords",
			"excludeReplies",
			"excludeReposts",
		]),
		getAuthRequirements: () => ({
			variables: Variables,
			satisfied: Variables.every((key) => Boolean(env[key])),
		}),
		async validateTarget(input) {
			const handle =
				/^(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/)?@?(\w{1,15})\/?$/.exec(
					input,
				)?.[1];
			if (!handle) return err({ _tag: "InvalidTarget" });
			const url = new URL(`https://api.x.com/2/users/by/username/${handle}`);
			url.searchParams.set("user.fields", "protected");
			const result = await read(url);
			if (result.isErr())
				return err({
					_tag:
						result.unwrapErr()._tag === "TargetUnavailable"
							? "TargetNotFound"
							: "TargetUnreachable",
				});
			const parsed = await Result.fromAsync(
				() => result.unwrap().json() as Promise<{ data?: XUser }>,
			);
			if (parsed.isErr()) return err({ _tag: "TargetUnreachable" });
			const user = parsed.unwrap().data;
			if (!user?.id) return err({ _tag: "TargetNotFound" });
			return user.protected
				? err({ _tag: "TargetBlocked" })
				: ok({ target: user.id, displayName: `@${user.username}` });
		},
		async fetchLatest(target, state) {
			if (!/^\d+$/.test(target)) return err({ _tag: "TargetUnavailable" });
			const url = new URL(`https://api.x.com/2/users/${target}/tweets`);
			url.search = new URLSearchParams({
				max_results: "100",
				"tweet.fields": "created_at,referenced_tweets,attachments,author_id",
				expansions: "author_id,attachments.media_keys",
				"user.fields": "username,name,profile_image_url",
				"media.fields": "url,preview_image_url",
			}).toString();
			const previous =
				isObject(state) &&
				"sinceId" in state &&
				typeof state.sinceId === "string"
					? state.sinceId
					: null;
			if (previous) url.searchParams.set("since_id", previous);
			const pages: XResponse[] = [];
			for (let page = 0; page < 10; page++) {
				// oxlint-disable-next-line no-await-in-loop -- X pagination is sequential
				const result = await read(url);
				if (result.isErr()) return err(result.unwrapErr());
				// oxlint-disable-next-line no-await-in-loop -- parse this page before requesting the next
				const parsed = await Result.fromAsync(
					() => result.unwrap().json() as Promise<XResponse>,
				);
				if (parsed.isErr()) return err({ _tag: "InvalidResponse" });
				const body = parsed.unwrap();
				pages.push(body);
				if (!body.meta?.next_token) break;
				if (page === 9) return err({ _tag: "Unavailable" });
				url.searchParams.set("pagination_token", body.meta.next_token);
			}
			const body: XResponse = {
				data: pages.flatMap((page) => page.data ?? []),
				includes: {
					users: pages.flatMap((page) => page.includes?.users ?? []),
					media: pages.flatMap((page) => page.includes?.media ?? []),
				},
			};
			if (body.data !== undefined && !Array.isArray(body.data))
				return err({ _tag: "InvalidResponse" });
			const items: SocialItem[] = (body.data ?? []).map((post) => {
				const author = body.includes?.users?.find(
					(user) => user.id === post.author_id,
				);
				const media = body.includes?.media?.find((entry) =>
					post.attachments?.media_keys?.includes(entry.media_key),
				);
				return {
					id: post.id,
					url: `https://x.com/i/status/${post.id}`,
					title: null,
					text: post.text,
					authorName: author?.name ?? null,
					authorAvatarUrl: parseImageUrl(author?.profile_image_url),
					imageUrl: parseImageUrl(media?.url ?? media?.preview_image_url),
					publishedAt: post.created_at ? new Date(post.created_at) : null,
					isReply:
						post.referenced_tweets?.some((ref) => ref.type === "replied_to") ??
						false,
					isRepost:
						post.referenced_tweets?.some((ref) => ref.type === "retweeted") ??
						false,
				};
			});
			return ok({
				_tag: "Items",
				items,
				state: { sinceId: items[0]?.id ?? previous ?? "" },
			});
		},
		formatNotification(item, source, t) {
			return createSocialCard(item, {
				accentColor: SocialColors.X,
				heading: t("events/social:xHeading", { name: source.displayName }),
				footer: t("events/social:xFooter"),
				linkLabel: t("events/social:openPost"),
			});
		},
	};
}
