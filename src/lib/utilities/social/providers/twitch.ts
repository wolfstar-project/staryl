import type {
	ProviderFailure,
	SocialItem,
	SocialProvider,
	TargetError,
} from "#social/provider";
import type { Result } from "@sapphire/result";
import type { TwitchHelixResponse } from "@wolfstar/twitch-helpers";
import { SocialProviderName } from "#generated/prisma";
import { toHttpFailure } from "#social/http";
import {
	createSocialCard,
	parseImageUrl,
	parseItemUrl,
} from "#social/notifications";
import { err, ok, Result as ResultNamespace } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";
import {
	areTwitchClientCredentialsSet,
	fetchUsers,
	getRequest,
	TwitchBrandingColor,
} from "@wolfstar/twitch-helpers";

const LoginPattern =
	/^(?:(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/)?(\w{3,25})\/?$/i;
const PageSize = 20;
/**
 * Helix ranks clips by views, with no way to ask for the newest. A short window and a full page keep
 * a clip made minutes ago from losing out to the most watched ones of the day.
 */
const ClipWindow = Time.Hour * 2;
const ClipPageSize = 100;
/** Enough for any channel but the very largest, and a bound on what one check can cost. */
const MaximumClipPages = 3;
/** Twitch serves this while a video is being processed, or while its stream is still live. */
const ProcessingThumbnailMarker = "/_404/";

interface TwitchVideo {
	id: string;
	title: string;
	description: string;
	url: string;
	user_name: string;
	thumbnail_url: string;
	published_at: string;
	/** Such as `3h8m33s`. */
	duration: string;
}

interface TwitchClip {
	id: string;
	title: string;
	url: string;
	creator_name: string;
	thumbnail_url: string;
	created_at: string;
}

const CommonOptions = {
	concurrency: 2,
	// The same limit and scope make the two providers below share one budget, as Helix counts per
	// app token.
	rateLimit: { limit: 120, windowMs: Time.Minute },
	supportedFilters: new Set(["includeKeywords", "excludeKeywords"]),
	rateLimitScope: () => "twitch",
	getAuthRequirements: () => ({
		variables: ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"],
		satisfied: areTwitchClientCredentialsSet(),
	}),
	validateTarget,
} satisfies Partial<SocialProvider>;

/**
 * Past broadcasts, highlights and uploads, read from Helix. Unlike going live, publishing a video
 * has no EventSub event, so this is polled.
 */
export function createTwitchVideosProvider(): SocialProvider {
	return {
		...CommonOptions,
		name: SocialProviderName.TwitchVideos,
		checkIntervalMs: Time.Minute * 15,

		async fetchLatest(target) {
			const result = await get<TwitchVideo>(
				`videos?user_id=${target}&first=${PageSize}&sort=time&type=all`,
			);
			if (result.isErr()) return err(result.unwrapErr());

			return ok({
				_tag: "Items",
				items: result.unwrap().data.flatMap(toVideoItem),
				state: null,
			});
		},

		formatNotification(item, source, t) {
			return createSocialCard(item, {
				accentColor: TwitchBrandingColor,
				heading: t("events/social:twitchVideoHeading", {
					name: source.displayName,
				}),
				footer: t("events/twitch:offlinePostfix"),
				linkLabel: t("events/social:watchVideo"),
			});
		},
	};
}

/** Clips the community made of a channel, read from Helix for the same reason as the videos. */
export function createTwitchClipsProvider(
	now: () => number = Date.now,
): SocialProvider {
	return {
		...CommonOptions,
		name: SocialProviderName.TwitchClips,
		checkIntervalMs: Time.Minute * 10,

		async fetchLatest(target) {
			const since = new Date(now() - ClipWindow).toISOString();
			const clips: TwitchClip[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < MaximumClipPages; page += 1) {
				const after = cursor ? `&after=${encodeURIComponent(cursor)}` : "";
				// oxlint-disable-next-line no-await-in-loop -- each cursor comes from the previous page
				const result = await get<TwitchClip>(
					`clips?broadcaster_id=${target}&first=${ClipPageSize}&started_at=${encodeURIComponent(since)}${after}`,
				);
				if (result.isErr()) return err(result.unwrapErr());

				clips.push(...result.unwrap().data);
				({ cursor } = result.unwrap());
				if (!cursor) break;
			}

			const newestFirst = clips.toSorted(
				(a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
			);
			return ok({
				_tag: "Items",
				items: newestFirst.flatMap(toClipItem),
				state: null,
			});
		},

		formatNotification(item, source, t) {
			return createSocialCard(item, {
				accentColor: TwitchBrandingColor,
				heading: t("events/social:twitchClipHeading", {
					name: source.displayName,
				}),
				footer: t("events/twitch:offlinePostfix"),
				linkLabel: t("events/social:watchVideo"),
			});
		},
	};
}

async function validateTarget(input: string) {
	const login = LoginPattern.exec(input)?.[1];
	if (!login) return err<TargetError>({ _tag: "InvalidTarget" });

	// `Result.fromAsync` flattens the `FetchResult` and also catches the throw for missing credentials.
	const result = await ResultNamespace.fromAsync(() =>
		fetchUsers({ logins: [login.toLowerCase()] }),
	);
	if (result.isErr()) return err<TargetError>({ _tag: "TargetUnreachable" });

	const [user] = result.unwrap().data;
	if (!user) return err<TargetError>({ _tag: "TargetNotFound" });

	return ok({ target: user.id, displayName: user.display_name });
}

async function get<T extends object>(
	path: string,
): Promise<Result<{ data: T[]; cursor?: string }, ProviderFailure>> {
	const result = await ResultNamespace.fromAsync(() =>
		getRequest<TwitchHelixResponse<T> & { pagination?: { cursor?: string } }>(
			path,
		),
	);
	if (result.isErr()) return err(toFailure(result.unwrapErr()));

	const { data, pagination } = result.unwrap();
	return Array.isArray(data)
		? ok({ data, cursor: pagination?.cursor })
		: err({ _tag: "InvalidResponse" });
}

function toFailure(error: unknown): ProviderFailure {
	const { code, response } = error as {
		code?: number;
		response?: Response;
	};
	return typeof code === "number"
		? toHttpFailure(code, response?.headers.get("retry-after"))
		: { _tag: "Unavailable" };
}

function toVideoItem(video: TwitchVideo): SocialItem[] {
	const url = parseItemUrl(video.url);
	// Left out until it is finished: being listed again later is what makes it count as new.
	if (
		url === null ||
		!video.thumbnail_url ||
		video.thumbnail_url.includes(ProcessingThumbnailMarker)
	) {
		return [];
	}

	return [
		{
			id: video.id,
			url,
			title: video.title,
			text: video.description || null,
			authorName: video.user_name,
			authorAvatarUrl: null,
			imageUrl: parseImageUrl(
				video.thumbnail_url
					.replace("%{width}", "1280")
					.replace("%{height}", "720"),
			),
			publishedAt: getVideoEnd(video),
		},
	];
}

/**
 * Helix dates a past broadcast by when the stream started. What counts here is when it became a
 * video, or one finished after a server subscribed would read as older than the subscription.
 */
function getVideoEnd({ published_at: start, duration }: TwitchVideo) {
	const [, hours, minutes, seconds] =
		/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration) ?? [];
	const length =
		Number(hours ?? 0) * Time.Hour +
		Number(minutes ?? 0) * Time.Minute +
		Number(seconds ?? 0) * Time.Second;
	return new Date(Date.parse(start) + length);
}

function toClipItem(clip: TwitchClip): SocialItem[] {
	const url = parseItemUrl(clip.url);
	if (url === null) return [];

	return [
		{
			id: clip.id,
			url,
			title: clip.title,
			text: null,
			authorName: clip.creator_name,
			authorAvatarUrl: null,
			imageUrl: parseImageUrl(clip.thumbnail_url),
			publishedAt: new Date(clip.created_at),
		},
	];
}
