import type { SocialItem } from "#social/provider";
import {
	DefaultSocialFilters,
	evaluateItem,
	getActiveFilters,
	parseKeywordList,
	parseSocialFilters,
} from "#social/filters";
import { Time } from "@sapphire/time-utilities";
import { describe, expect, it } from "vitest";

const Now = Date.UTC(2026, 10, 1, 12);

function makeItem(overrides: Partial<SocialItem> = {}): SocialItem {
	return {
		id: "1",
		url: "https://example.com/1",
		title: "Release notes",
		text: "A new version is out",
		authorName: null,
		authorAvatarUrl: null,
		imageUrl: null,
		publishedAt: new Date(Now),
		...overrides,
	};
}

function evaluate(
	item: Partial<SocialItem>,
	filters: Partial<typeof DefaultSocialFilters>,
	channelIsNsfw = false,
) {
	return evaluateItem(
		makeItem(item),
		{ ...DefaultSocialFilters, ...filters },
		{ channelIsNsfw, now: Now, subscribedAt: new Date(0) },
	);
}

describe("parseKeywordList", () => {
	it("splits on commas, trims, lowercases and drops blanks and duplicates", () => {
		expect(parseKeywordList(" Rust, ,GO,rust ")).toEqual(["rust", "go"]);
	});

	it.each([null, undefined, ""])("answers nothing for %j", (input) => {
		expect(parseKeywordList(input)).toEqual([]);
	});
});

describe("parseSocialFilters", () => {
	it("falls back to the defaults for fields that are missing or malformed", () => {
		expect(
			parseSocialFilters({
				includeKeywords: ["rust", 1],
				excludeReplies: "yes",
				shorts: "sometimes",
				minimumScore: "10",
			}),
		).toEqual({ ...DefaultSocialFilters, includeKeywords: ["rust"] });
	});

	it.each([null, 1, "x"])("answers the defaults for %j", (value) => {
		expect(parseSocialFilters(value)).toEqual(DefaultSocialFilters);
	});
});

describe("getActiveFilters", () => {
	it("names only the filters that differ from their default", () => {
		expect(
			getActiveFilters({
				...DefaultSocialFilters,
				includeKeywords: ["rust"],
				minimumScore: 10,
			}),
		).toEqual(["includeKeywords", "minimumScore"]);
	});
});

describe("evaluateItem", () => {
	it("delivers everything by default", () => {
		expect(evaluate({}, {})).toBe("deliver");
	});

	it("skips an item older than the subscription, but not an undated one", () => {
		const context = {
			channelIsNsfw: false,
			now: Now,
			subscribedAt: new Date(Now),
		};
		const older = new Date(Now - 1);

		expect(
			evaluateItem(
				makeItem({ publishedAt: older }),
				DefaultSocialFilters,
				context,
			),
		).toBe("skip");
		expect(
			evaluateItem(
				makeItem({ publishedAt: null }),
				DefaultSocialFilters,
				context,
			),
		).toBe("deliver");
	});

	it.each([
		["a keyword in the title", ["release"], "deliver"],
		["a keyword in the text", ["version"], "deliver"],
		["any of several keywords", ["nothing", "version"], "deliver"],
		["no matching keyword", ["nothing"], "skip"],
	])("handles %s", (_, includeKeywords, verdict) => {
		expect(evaluate({}, { includeKeywords })).toBe(verdict);
	});

	it("matches keywords regardless of case and width", () => {
		expect(
			evaluate({ title: "ＲＥＬＥＡＳＥ" }, { includeKeywords: ["release"] }),
		).toBe("deliver");
	});

	it("lets an excluded keyword win over an included one", () => {
		expect(
			evaluate(
				{},
				{ includeKeywords: ["release"], excludeKeywords: ["version"] },
			),
		).toBe("skip");
	});

	it.each([
		[{ isReply: true }, { excludeReplies: true }],
		[{ isRepost: true }, { excludeReposts: true }],
		[{ isShort: true }, { shorts: "exclude" as const }],
		[{ isShort: false }, { shorts: "only" as const }],
		[{ flair: "Meme" }, { flairs: ["news"] }],
		[{ flair: null }, { flairs: ["news"] }],
	])("skips %j under %j", (item, filters) => {
		expect(evaluate(item, filters)).toBe("skip");
	});

	it("keeps a matching flair regardless of case", () => {
		expect(evaluate({ flair: "NEWS" }, { flairs: ["news"] })).toBe("deliver");
	});

	it("keeps an NSFW item out of a channel not marked as NSFW", () => {
		expect(evaluate({ isNsfw: true }, {})).toBe("skip");
		expect(evaluate({ isNsfw: true }, {}, true)).toBe("deliver");
	});

	it("delivers a post that reached the score threshold", () => {
		expect(evaluate({ score: 10 }, { minimumScore: 10 })).toBe("deliver");
	});

	it("waits for a recent post that is below the score threshold", () => {
		expect(evaluate({ score: 9 }, { minimumScore: 10 })).toBe("wait");
	});

	it("gives up on a post that stayed below the threshold for a day", () => {
		const publishedAt = new Date(Now - Time.Day - 1);
		expect(evaluate({ score: 9, publishedAt }, { minimumScore: 10 })).toBe(
			"skip",
		);
	});

	it("does not wait on a threshold the item can never be held for", () => {
		expect(
			evaluate({ flair: "Meme" }, { flairs: ["news"], minimumScore: 10 }),
		).toBe("skip");
	});
});
