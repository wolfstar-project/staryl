import type { Prisma, SocialProviderName } from "#lib/setup/prisma";
import type { SocialFilterName } from "#social/filters";
import type { Result } from "@sapphire/result";
import type { AnyNamespace, TFunction } from "@wolfstar/plugin-i18next";

/**
 * Why a check of a source failed.
 *
 * The tags double as the values of the `SocialFailure` column, and each one is backed off and
 * reported differently, see `planNextCheck` and `describeSourceHealth`.
 */
export type ProviderFailure =
	| { _tag: "RateLimited"; retryAfterMs: number | null }
	| { _tag: "TargetUnavailable" }
	| { _tag: "AuthFailed" }
	| { _tag: "Unavailable" }
	| { _tag: "InvalidResponse" };

/** Why a target could not be linked. Each tag answers `add` with its own message. */
export type TargetError =
	| { _tag: "InvalidTarget" }
	| { _tag: "TargetNotFound" }
	| { _tag: "TargetBlocked" }
	| { _tag: "TargetUnsupported" }
	| { _tag: "TargetUnreachable" };

export interface ResolvedTarget {
	/** The canonical key of the source: the same account always resolves to the same value. */
	target: string;
	displayName: string;
}

/** Optional facts a filter can act on. A provider sets the ones it knows about. */
export interface SocialItemTraits {
	isReply?: boolean;
	isReel?: boolean;
	isRepost?: boolean;
	isShort?: boolean;
	isNsfw?: boolean;
	isSpoiler?: boolean;
	flair?: string | null;
	score?: number | null;
}

/** One post, video or article, normalized so filtering and delivery need no provider knowledge. */
export interface SocialItem extends SocialItemTraits {
	/** Stable across fetches: this is what deduplication is keyed on. */
	id: string;
	url: string;
	title: string | null;
	text: string | null;
	authorName: string | null;
	authorAvatarUrl: string | null;
	imageUrl: string | null;
	publishedAt: Date | null;
}

export type FetchOutcome =
	| { _tag: "NotModified" }
	| {
			_tag: "Items";
			/** Newest first, as every source already lists them. */
			items: SocialItem[];
			/** Handed back on the next {@link SocialProvider.fetchLatest} call for this source. */
			state: Prisma.InputJsonValue | null;
	  };

export interface AuthRequirements {
	/** The environment variables the provider needs. Empty when it needs no credentials. */
	variables: readonly string[];
	satisfied: boolean;
}

/** What {@link SocialProvider.formatNotification} produces. Rendered by `buildSocialComponents`. */
export interface SocialCard {
	accentColor: number;
	heading: string;
	title: string | null;
	url: string;
	body: string | null;
	thumbnailUrl: string | null;
	imageUrl: string | null;
	footer: string;
	linkLabel: string;
	publishedAt: Date | null;
}

export interface NotifiedSource {
	target: string;
	displayName: string;
}

/**
 * The contract of a social integration. Implementing it and adding the instance to
 * `SocialProviders` is all a new integration needs: the poller, the filters, delivery and the
 * `/subscriptions social` commands work from this interface alone.
 *
 * Expected failures are returned, never thrown. A method that throws anyway is treated as
 * `Unavailable` for that one source, so a bug in a provider cannot stop the others.
 */
export interface SocialProvider {
	readonly name: SocialProviderName;
	/** How often a healthy source is checked. */
	readonly checkIntervalMs: number;
	/** How many sources of this provider are checked at once. */
	readonly concurrency: number;
	/** The requests allowed per {@link rateLimitScope} and time window. */
	readonly rateLimit: { limit: number; windowMs: number };
	/** The filters this provider has the data for. `add` refuses any other. */
	readonly supportedFilters: ReadonlySet<SocialFilterName>;
	/** Sources sharing a scope share a budget, such as one API token or one remote host. */
	rateLimitScope(target: string): string;
	getAuthRequirements(): AuthRequirements;
	/** Turns what a member typed into a canonical target, or says why it cannot be linked. */
	validateTarget(input: string): Promise<Result<ResolvedTarget, TargetError>>;
	fetchLatest(
		target: string,
		state: Prisma.JsonValue | null,
	): Promise<Result<FetchOutcome, ProviderFailure>>;
	formatNotification(
		item: SocialItem,
		source: NotifiedSource,
		t: TFunction<AnyNamespace>,
	): SocialCard;
}
