import type {
	ConnectedAccountApi,
	ConnectedToken,
} from "#social/connectedAccounts";
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

export interface TikTokOptions {
	fetch?: typeof fetch;
	env?: Record<string, string | undefined>;
	now?: () => number;
}
interface TikTokTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	open_id: string;
	scope: string;
}
interface TikTokVideo {
	id: string;
	title?: string;
	video_description?: string;
	share_url: string;
	cover_image_url?: string;
	create_time?: number;
}
interface TikTokEnvelope<T> {
	data: T;
	error?: { code: string };
}
export function createTikTokApi(
	options: TikTokOptions = {},
): ConnectedAccountApi {
	const { fetch: request = fetch, env = process.env, now = Date.now } = options;
	const redirectUri = env.TIKTOK_REDIRECT_URI ?? "";
	async function tokenRequest(
		parameters: Record<string, string>,
		previous?: ConnectedToken,
	): Promise<Result<ConnectedToken, ProviderFailure>> {
		const result = await readConnectedJson<TikTokTokenResponse>(
			request,
			"https://open.tiktokapis.com/v2/oauth/token/",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_key: env.TIKTOK_CLIENT_KEY!,
					client_secret: env.TIKTOK_CLIENT_SECRET!,
					...parameters,
				}),
			},
		);
		if (result.isErr()) return err(result.unwrapErr());
		const token = result.unwrap();
		if (
			!token.access_token ||
			!token.refresh_token ||
			!token.open_id ||
			!(token.expires_in > 0) ||
			!token.scope?.split(",").includes("video.list")
		)
			return err({ _tag: "AuthFailed" });
		if (previous && previous.accountId !== token.open_id)
			return err({ _tag: "AuthFailed" });
		return ok({
			accessToken: token.access_token,
			refreshToken: token.refresh_token,
			accountId: token.open_id,
			displayName: previous?.displayName ?? token.open_id,
			expiresAt: now() + token.expires_in * 1000,
		});
	}
	async function api<T>(
		path: string,
		token: string,
		init: RequestInit = {},
	): Promise<Result<T, ProviderFailure>> {
		const result = await readConnectedJson<TikTokEnvelope<T>>(
			request,
			`https://open.tiktokapis.com/v2/${path}`,
			{
				...init,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
			},
		);
		if (result.isErr()) return err(result.unwrapErr());
		const body = result.unwrap();
		if (body.error?.code && body.error.code !== "ok")
			return err({
				_tag:
					body.error.code === "access_token_invalid"
						? "AuthFailed"
						: body.error.code === "rate_limit_exceeded"
							? "RateLimited"
							: "Unavailable",
				retryAfterMs: 60_000,
			} as ProviderFailure);
		return body.data ? ok(body.data) : err({ _tag: "InvalidResponse" });
	}
	return {
		name: SocialProviderName.TikTok,
		redirectUri,
		refreshWindowMs: Time.Minute * 10,
		configured:
			env.TIKTOK_APP_APPROVED === "true" &&
			Boolean(
				env.TIKTOK_CLIENT_KEY &&
				env.TIKTOK_CLIENT_SECRET &&
				env.SOCIAL_TOKEN_KEY &&
				redirectUri.startsWith("https://"),
			),
		authorize(state) {
			return `https://www.tiktok.com/v2/auth/authorize/?${new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY!, redirect_uri: redirectUri, response_type: "code", scope: "user.info.basic,video.list", state })}`;
		},
		async exchange(code) {
			const result = await tokenRequest({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
			});
			if (result.isErr()) return result;
			const token = result.unwrap();
			const profile = await api<{ user: { display_name: string } }>(
				"user/info/?fields=open_id,display_name",
				token.accessToken,
			);
			return profile.isErr()
				? err(profile.unwrapErr())
				: ok({ ...token, displayName: profile.unwrap().user.display_name });
		},
		async refresh(token) {
			return token.refreshToken
				? tokenRequest(
						{ grant_type: "refresh_token", refresh_token: token.refreshToken },
						token,
					)
				: err({ _tag: "AuthFailed" });
		},
		async media(token) {
			const result = await api<{ videos: TikTokVideo[] }>(
				"video/list/?fields=id,title,video_description,share_url,cover_image_url,create_time",
				token.accessToken,
				{ method: "POST", body: JSON.stringify({ max_count: 20 }) },
			);
			if (result.isErr()) return err(result.unwrapErr());
			if (!Array.isArray(result.unwrap().videos))
				return err({ _tag: "InvalidResponse" });
			return ok(
				result.unwrap().videos.flatMap((video): SocialItem[] => {
					const url = parseItemUrl(video.share_url);
					if (!video.id || !url) return [];
					return [
						{
							id: video.id,
							url,
							title: video.title ?? null,
							text: video.video_description ?? null,
							imageUrl: parseImageUrl(video.cover_image_url),
							authorName: token.displayName,
							authorAvatarUrl: null,
							publishedAt: video.create_time
								? new Date(video.create_time * 1000)
								: null,
						},
					];
				}),
			);
		},
	};
}
export function createTikTokProvider(
	options: TikTokOptions = {},
): SocialProvider {
	const client = createTikTokApi(options);
	return {
		name: SocialProviderName.TikTok,
		checkIntervalMs: Time.Minute * 10,
		concurrency: 2,
		rateLimit: { limit: 30, windowMs: Time.Hour },
		rateLimitScope: (target) => `tiktok:${target}`,
		supportedFilters: new Set(["includeKeywords", "excludeKeywords"]),
		getAuthRequirements: () => ({
			variables: [
				"TIKTOK_CLIENT_KEY",
				"TIKTOK_CLIENT_SECRET",
				"TIKTOK_REDIRECT_URI",
				"TIKTOK_APP_APPROVED",
				"SOCIAL_TOKEN_KEY",
			],
			satisfied: client.configured,
		}),
		async validateTarget(input) {
			if (!/^\d+:[\w-]+$/.test(input))
				return err({ _tag: "TargetUnsupported" });
			const connection = await container.prisma.socialConnection.findUnique({
				where: {
					provider_target: {
						provider: SocialProviderName.TikTok,
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
				accentColor: SocialColors.TikTok,
				heading: t("events/social:tiktokHeading", { name: source.displayName }),
				footer: t("events/social:tiktokFooter"),
				linkLabel: t("events/social:openPost"),
			});
		},
	};
}
