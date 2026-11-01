import type {
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
import { htmlToText } from "#social/feed";
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

const StatusPageSize = 30;
const AddressPattern = /^@?([\w.-]+)@([a-z\d-]+(?:\.[a-z\d-]+)+)$/i;
const ProfileUrlPattern =
	/^https?:\/\/([a-z\d-]+(?:\.[a-z\d-]+)+)\/@([\w.-]+)\/?$/i;

interface MastodonAccount {
	id: string;
	acct: string;
	username: string;
	display_name?: string;
	avatar?: string;
}

interface MastodonStatus {
	id: string;
	url?: string | null;
	uri: string;
	created_at: string;
	in_reply_to_id?: string | null;
	visibility?: string;
	sensitive?: boolean;
	spoiler_text?: string;
	content?: string;
	reblog?: MastodonStatus | null;
	account: MastodonAccount;
	media_attachments?: { type?: string; preview_url?: string | null }[];
}

/**
 * Follows an account on any Fediverse server speaking Mastodon's API, whose public endpoints need
 * no login. Each server is its own API host with its own limits, and it is named by a member, so
 * requests go through `fetchPublicUrl` and budgets are kept per server.
 *
 * The target is `host/id`: an account id is only unique on its own server.
 */
export function createMastodonProvider(
	fetchUrl: PublicFetcher = fetchPublicUrl,
): SocialProvider {
	const get = (host: string, path: string) =>
		fetchUrl(`https://${host}/api/v1/${path}`, {
			headers: { accept: "application/json", "user-agent": SocialUserAgent },
		});

	return {
		name: SocialProviderName.Mastodon,
		checkIntervalMs: Time.Minute * 5,
		concurrency: 4,
		rateLimit: { limit: 60, windowMs: Time.Minute * 5 },
		supportedFilters: new Set([
			"includeKeywords",
			"excludeKeywords",
			"excludeReplies",
			"excludeReposts",
		]),
		rateLimitScope: (target) => target.split("/")[0],
		getAuthRequirements: () => ({ variables: [], satisfied: true }),

		async validateTarget(input) {
			const address = parseAddress(input);
			if (address === null) return err({ _tag: "InvalidTarget" });

			const { host, username } = address;
			const result = await get(
				host,
				`accounts/lookup?acct=${encodeURIComponent(username)}`,
			);
			if (result.isErr()) return err(toTargetError(result.unwrapErr()));

			return readAccount(result.unwrap(), host, username);
		},

		async fetchLatest(target) {
			const [host, id] = target.split("/");
			const result = await get(
				host,
				`accounts/${id}/statuses?limit=${StatusPageSize}`,
			);
			if (result.isErr()) return err(toProviderFailure(result.unwrapErr()));

			const response = result.unwrap();
			if (response.status < 200 || response.status >= 300) {
				return err(toStatusFailure(response));
			}

			const statuses = parseJson<unknown[]>(response.body);
			if (!Array.isArray(statuses)) return err({ _tag: "InvalidResponse" });

			return ok({
				_tag: "Items",
				items: statuses.filter(isStatus).flatMap(toItem),
				state: null,
			});
		},

		formatNotification(item, source, t) {
			return createSocialCard(item, {
				accentColor: SocialColors.Mastodon,
				heading: t("events/social:mastodonHeading", {
					name: item.authorName ?? source.displayName,
				}),
				footer: t("events/social:mastodonFooter"),
				linkLabel: t("events/social:openPost"),
			});
		},
	};
}

function parseAddress(input: string) {
	const address = AddressPattern.exec(input);
	if (address) return { username: address[1], host: address[2].toLowerCase() };

	const url = ProfileUrlPattern.exec(input);
	return url ? { username: url[2], host: url[1].toLowerCase() } : null;
}

function readAccount(
	response: PublicResponse,
	host: string,
	username: string,
): Result<ResolvedTarget, TargetError> {
	if (response.status === 404) return err({ _tag: "TargetNotFound" });
	// A server in limited mode refuses anonymous reads, so there is nothing we may show from it.
	if (response.status === 401 || response.status === 403) {
		return err({ _tag: "TargetBlocked" });
	}
	if (response.status < 200 || response.status >= 300) {
		return err({ _tag: "TargetUnreachable" });
	}

	const account = parseJson<MastodonAccount>(response.body);
	// The id becomes part of a stored target and of later URLs, and any server can answer here.
	if (typeof account?.id !== "string" || !/^\w{1,64}$/.test(account.id)) {
		return err({ _tag: "TargetUnsupported" });
	}

	return ok({
		target: `${host}/${account.id}`,
		displayName: readText(account.display_name) || `@${username}@${host}`,
	});
}

function toItem(status: MastodonStatus): SocialItem[] {
	// Only what the author published for everyone. Unlisted posts asked to stay out of public feeds.
	if (status.visibility !== "public") return [];

	const shown = isStatus(status.reblog) ? status.reblog : status;
	const url = parseItemUrl(shown.url ?? shown.uri);
	if (url === null) return [];

	const warning = readText(shown.spoiler_text).trim();
	return [
		{
			id: status.id,
			url,
			title: null,
			// A content warning hides the post behind a click, and it has to stay hidden here too.
			text: warning || htmlToText(readText(shown.content)),
			authorName:
				readText(shown.account.display_name) ||
				`@${readText(shown.account.acct)}`,
			authorAvatarUrl: parseImageUrl(shown.account.avatar),
			imageUrl: warning || shown.sensitive ? null : readImage(shown),
			publishedAt: new Date(status.created_at),
			isReply: Boolean(status.in_reply_to_id),
			isRepost: shown !== status,
		},
	];
}

function readImage(status: MastodonStatus) {
	const attachments = status.media_attachments;
	const picture = Array.isArray(attachments)
		? attachments.find(
				(entry) =>
					entry?.type === "image" ||
					entry?.type === "gifv" ||
					entry?.type === "video",
			)
		: null;
	return parseImageUrl(picture?.preview_url);
}

/** Any server can answer this API, so what it sends is checked rather than assumed. */
function isStatus(value: unknown): value is MastodonStatus {
	if (!isObject(value)) return false;

	const {
		id,
		uri,
		created_at: createdAt,
		account,
	} = value as Record<string, unknown>;
	return (
		typeof id === "string" &&
		typeof uri === "string" &&
		typeof createdAt === "string" &&
		isObject(account)
	);
}

function readText(value: unknown) {
	return typeof value === "string" ? value : "";
}

function parseJson<T>(body: string): T | null {
	try {
		return JSON.parse(body) as T;
	} catch {
		// A server that is not Fediverse software answers HTML; that just means it is unsupported.
		return null;
	}
}

function toStatusFailure(response: PublicResponse): ProviderFailure {
	if (response.status === 401 || response.status === 403) {
		return { _tag: "TargetUnavailable" };
	}

	const retryAfter = response.headers["retry-after"];
	return toHttpFailure(
		response.status,
		Array.isArray(retryAfter) ? retryAfter[0] : retryAfter,
	);
}

function toTargetError(error: PublicFetchError): TargetError {
	return error._tag === "ForbiddenAddress"
		? { _tag: "TargetBlocked" }
		: { _tag: "TargetUnreachable" };
}

function toProviderFailure(error: PublicFetchError): ProviderFailure {
	return error._tag === "ForbiddenAddress"
		? { _tag: "TargetUnavailable" }
		: { _tag: "Unavailable" };
}
