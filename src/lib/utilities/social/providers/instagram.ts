import type { ConnectedAccountApi } from "#social/connectedAccounts";
import type {
	SocialProvider,
	SocialItem,
	ProviderFailure,
} from "#social/provider";
import type { Result } from "@sapphire/result";
import { SocialColors } from "#common/constants";
import { SocialProviderName } from "#generated/prisma";
import { readConnectedMedia } from "#social/connectedAccounts";
import { readConnectedJson } from "#social/connectedHttp";
import {
	createSocialCard,
	parseImageUrl,
	parseItemUrl,
} from "#social/notifications";
import { err, ok } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";
import { container } from "@wolfstar/http-framework";

interface TokenResponse {
	access_token: string;
	expires_in: number;
}
interface InstagramMedia {
	id: string;
	caption?: string;
	media_type: string;
	media_product_type?: string;
	media_url?: string;
	thumbnail_url?: string;
	permalink: string;
	username?: string;
	timestamp?: string;
}
export interface InstagramOptions {
	fetch?: typeof fetch;
	env?: Record<string, string | undefined>;
	now?: () => number;
}

export function createInstagramApi(
	options: InstagramOptions = {},
): ConnectedAccountApi {
	const { fetch: request = fetch, env = process.env, now = Date.now } = options;
	const redirectUri = env.INSTAGRAM_REDIRECT_URI ?? "";
	const read = <T>(url: string, init: RequestInit = {}) =>
		readConnectedJson<T>(request, url, init);
	const query = (path: string, parameters: Record<string, string>) =>
		`https://graph.instagram.com/${path}?${new URLSearchParams(parameters)}`;
	async function longToken(
		accessToken: string,
		refresh: boolean,
	): Promise<Result<TokenResponse, ProviderFailure>> {
		return read<TokenResponse>(
			query(
				refresh ? "refresh_access_token" : "access_token",
				refresh
					? { grant_type: "ig_refresh_token", access_token: accessToken }
					: {
							grant_type: "ig_exchange_token",
							client_secret: env.INSTAGRAM_APP_SECRET!,
							access_token: accessToken,
						},
			),
		);
	}
	return {
		name: SocialProviderName.Instagram,
		refreshWindowMs: Time.Day * 7,
		redirectUri,
		configured: Boolean(
			env.INSTAGRAM_APP_ID &&
			env.INSTAGRAM_APP_SECRET &&
			redirectUri.startsWith("https://") &&
			env.SOCIAL_TOKEN_KEY,
		),
		authorize(state) {
			return `https://www.instagram.com/oauth/authorize?${new URLSearchParams({ client_id: env.INSTAGRAM_APP_ID!, redirect_uri: redirectUri, response_type: "code", scope: "instagram_business_basic", state })}`;
		},
		async exchange(code) {
			const short = await read<{ access_token: string }>(
				"https://api.instagram.com/oauth/access_token",
				{
					method: "POST",
					body: new URLSearchParams({
						client_id: env.INSTAGRAM_APP_ID!,
						client_secret: env.INSTAGRAM_APP_SECRET!,
						grant_type: "authorization_code",
						redirect_uri: redirectUri,
						code,
					}),
				},
			);
			if (short.isErr()) return err(short.unwrapErr());
			if (!short.unwrap().access_token) return err({ _tag: "AuthFailed" });
			const long = await longToken(short.unwrap().access_token, false);
			if (long.isErr()) return err(long.unwrapErr());
			const token = long.unwrap();
			if (!token.access_token || !(token.expires_in > 0))
				return err({ _tag: "InvalidResponse" });
			const profile = await read<{
				user_id: string;
				username: string;
				account_type: string;
			}>(
				query("me", {
					fields: "user_id,username,account_type",
					access_token: token.access_token,
				}),
			);
			if (profile.isErr()) return err(profile.unwrapErr());
			const user = profile.unwrap();
			if (
				!user.user_id ||
				!["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(user.account_type)
			)
				return err({ _tag: "TargetUnavailable" });
			return ok({
				accessToken: token.access_token,
				accountId: String(user.user_id),
				displayName: user.username,
				expiresAt: now() + token.expires_in * 1000,
			});
		},
		async refresh(token) {
			const result = await longToken(token.accessToken, true);
			if (result.isErr()) return err(result.unwrapErr());
			const next = result.unwrap();
			return next.access_token && next.expires_in > 0
				? ok({
						...token,
						accessToken: next.access_token,
						expiresAt: now() + next.expires_in * 1000,
					})
				: err({ _tag: "AuthFailed" });
		},
		async media(token) {
			const response = await read<{ data: InstagramMedia[] }>(
				query("me/media", {
					fields:
						"id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,username,timestamp",
					limit: "50",
					access_token: token.accessToken,
				}),
			);
			if (response.isErr()) return err(response.unwrapErr());
			if (!Array.isArray(response.unwrap().data))
				return err({ _tag: "InvalidResponse" });
			return ok(
				response.unwrap().data.flatMap((media): SocialItem[] => {
					const url = parseItemUrl(media.permalink);
					if (!media.id || !url) return [];
					return [
						{
							id: media.id,
							url,
							title: media.media_product_type === "REELS" ? "Reel" : null,
							text: media.caption ?? null,
							authorName: media.username ?? token.displayName,
							authorAvatarUrl: null,
							imageUrl: parseImageUrl(
								media.media_type === "VIDEO"
									? media.thumbnail_url
									: media.media_url,
							),
							publishedAt: media.timestamp ? new Date(media.timestamp) : null,
						},
					];
				}),
			);
		},
	};
}

export function createInstagramProvider(
	options: InstagramOptions = {},
): SocialProvider {
	const client = createInstagramApi(options);
	return {
		name: SocialProviderName.Instagram,
		checkIntervalMs: Time.Minute * 10,
		concurrency: 2,
		rateLimit: { limit: 30, windowMs: Time.Hour },
		rateLimitScope: (target) => `instagram:${target}`,
		supportedFilters: new Set(["includeKeywords", "excludeKeywords"]),
		getAuthRequirements: () => ({
			variables: [
				"INSTAGRAM_APP_ID",
				"INSTAGRAM_APP_SECRET",
				"INSTAGRAM_REDIRECT_URI",
				"SOCIAL_TOKEN_KEY",
			],
			satisfied: client.configured,
		}),
		async validateTarget(input) {
			if (!/^\d+:\d+$/.test(input)) return err({ _tag: "TargetUnsupported" });
			const connection = await container.prisma.socialConnection.findUnique({
				where: {
					provider_target: {
						provider: SocialProviderName.Instagram,
						target: input,
					},
				},
			});
			return connection
				? ok({ target: input, displayName: connection.displayName })
				: err({ _tag: "TargetBlocked" });
		},
		async fetchLatest(target) {
			const result = await readConnectedMedia(client, target);
			return result.isErr()
				? err(result.unwrapErr())
				: ok({ _tag: "Items", items: result.unwrap(), state: null });
		},
		formatNotification(item, source, t) {
			return createSocialCard(item, {
				accentColor: SocialColors.Instagram,
				heading: t(
					item.title === "Reel"
						? "events/social:instagramReelHeading"
						: "events/social:instagramHeading",
					{ name: source.displayName },
				),
				footer: t("events/social:instagramFooter"),
				linkLabel: t("events/social:openPost"),
			});
		},
	};
}
