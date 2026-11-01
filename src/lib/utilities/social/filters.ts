import type { SocialItem } from "#social/provider";
import { Time } from "@sapphire/time-utilities";
import { isObject } from "@sapphire/utilities";

export type ShortsFilter = "include" | "exclude" | "only";

export interface SocialFilters {
	includeKeywords: readonly string[];
	excludeKeywords: readonly string[];
	excludeReplies: boolean;
	excludeReposts: boolean;
	shorts: ShortsFilter;
	flairs: readonly string[];
	minimumScore: number | null;
}

export type SocialFilterName = keyof SocialFilters;

/**
 * The outcome for one item in one channel. `wait` keeps the item unseen so the next check looks at
 * it again, which is what lets a post reach a score threshold after it was first fetched.
 */
export type FilterVerdict = "deliver" | "skip" | "wait";

export const DefaultSocialFilters: SocialFilters = {
	includeKeywords: [],
	excludeKeywords: [],
	excludeReplies: false,
	excludeReposts: false,
	shorts: "include",
	flairs: [],
	minimumScore: null,
};

/** How long a post may stay below the score threshold before it is given up on. */
export const ScoreWaitWindow = Time.Day;

export const MaximumKeywords = 20;

/** Splits a comma separated option into normalized keywords, dropping blanks and duplicates. */
export function parseKeywordList(input: string | null | undefined): string[] {
	if (!input) return [];

	const keywords = input
		.split(",")
		.map((keyword) => normalize(keyword).trim())
		.filter((keyword) => keyword.length > 0);
	return [...new Set(keywords)].slice(0, MaximumKeywords);
}

/**
 * Reads the stored `filters` column. The value crossed a JSON boundary and may predate a field, so
 * anything missing or malformed falls back to its default instead of failing the delivery.
 */
export function parseSocialFilters(value: unknown): SocialFilters {
	if (!isObject(value)) return DefaultSocialFilters;

	const record = value as Record<string, unknown>;
	const { shorts, minimumScore } = record;
	return {
		includeKeywords: toStringList(record.includeKeywords),
		excludeKeywords: toStringList(record.excludeKeywords),
		excludeReplies: record.excludeReplies === true,
		excludeReposts: record.excludeReposts === true,
		shorts: shorts === "exclude" || shorts === "only" ? shorts : "include",
		flairs: toStringList(record.flairs),
		minimumScore: typeof minimumScore === "number" ? minimumScore : null,
	};
}

/** The filters that differ from their default, which is what a provider has to support. */
export function getActiveFilters(filters: SocialFilters): SocialFilterName[] {
	return (Object.keys(DefaultSocialFilters) as SocialFilterName[]).filter(
		(name) =>
			JSON.stringify(filters[name]) !==
			JSON.stringify(DefaultSocialFilters[name]),
	);
}

export function evaluateItem(
	item: SocialItem,
	filters: SocialFilters,
	context: { channelIsNsfw: boolean; now: number; subscribedAt: Date },
): FilterVerdict {
	// A feed is a sliding window: delete the newest video and an old one slides back in, unseen.
	// Being older than the subscription is what tells it apart from something new.
	if (item.publishedAt && item.publishedAt < context.subscribedAt)
		return "skip";
	if (item.isNsfw && !context.channelIsNsfw) return "skip";
	if (filters.excludeReplies && item.isReply) return "skip";
	if (filters.excludeReposts && item.isRepost) return "skip";
	if (filters.shorts === "exclude" && item.isShort) return "skip";
	if (filters.shorts === "only" && !item.isShort) return "skip";
	if (!matchesFlair(item, filters) || !matchesKeywords(item, filters)) {
		return "skip";
	}

	if (filters.minimumScore === null) return "deliver";
	if ((item.score ?? 0) >= filters.minimumScore) return "deliver";

	const age = context.now - (item.publishedAt?.getTime() ?? 0);
	return age < ScoreWaitWindow ? "wait" : "skip";
}

function matchesFlair(item: SocialItem, filters: SocialFilters) {
	if (filters.flairs.length === 0) return true;

	const flair = normalize(item.flair ?? "");
	return filters.flairs.some((wanted) => wanted === flair);
}

function matchesKeywords(item: SocialItem, filters: SocialFilters) {
	const haystack = normalize(`${item.title ?? ""}\n${item.text ?? ""}`);
	const has = (keyword: string) => haystack.includes(keyword);

	if (filters.excludeKeywords.some(has)) return false;
	return (
		filters.includeKeywords.length === 0 || filters.includeKeywords.some(has)
	);
}

/** `NFKC` so a full-width or decorated keyword still matches its plain spelling. */
function normalize(text: string) {
	return text.normalize("NFKC").toLowerCase();
}

function toStringList(value: unknown) {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}
