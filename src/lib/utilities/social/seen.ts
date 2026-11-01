import type { SocialItem } from "#social/provider";
import { createHash } from "node:crypto";

const MaximumStoredIdLength = 256;

/**
 * How many items of one fetch are looked at. Providers ask for fewer, but a Mastodon server can
 * answer whatever it wants, and a window wider than the stored ids would make the oldest of them
 * look new on every single check.
 */
export const MaximumFetchedItems = 100;
/** Bounds the stored ids. Has to exceed {@link MaximumFetchedItems} for the reason above. */
export const MaximumSeenItems = 300;

/**
 * The form an item id is stored in. Ids come from the source, which may be hostile: a huge one
 * would bloat every row it lands in, and Postgres refuses a NUL byte, which would fail that source
 * on every check. Either way the item gets a digest, which is just as stable.
 */
export function toSeenId({ id }: Pick<SocialItem, "id">) {
	return id.length <= MaximumStoredIdLength && !id.includes("\0")
		? id
		: `sha256:${createHash("sha256").update(id).digest("hex")}`;
}

export function mergeSeenIds(
	seen: readonly string[],
	items: readonly SocialItem[],
) {
	return [...seen, ...items.map(toSeenId)].slice(-MaximumSeenItems);
}

/** The items of a fetch that are new to a subscription, oldest first and each of them once. */
export function findFreshItems(
	items: readonly SocialItem[],
	seenItemIds: readonly string[],
) {
	const seen = new Set(seenItemIds);
	const fresh = new Map<string, SocialItem>();
	for (const item of items.slice(0, MaximumFetchedItems)) {
		const id = toSeenId(item);
		if (!seen.has(id) && !fresh.has(id)) fresh.set(id, item);
	}

	return [...fresh.values()].toReversed();
}
