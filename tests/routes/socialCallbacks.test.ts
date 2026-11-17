import { join } from "node:path";
import { container } from "@wolfstar/http-framework";
import { RouterRoot, RouteStore } from "@wolfstar/plugin-api";
import { beforeEach, describe, expect, it } from "vitest";
import { UserRoute as InstagramCallback } from "../../src/routes/social/instagram/callback.get.ts";
import { UserRoute as TikTokCallback } from "../../src/routes/social/tiktok/callback.get.ts";

const Root = join(import.meta.dirname, "../../src/routes");

/** Builds a route as the loader does: named after its file, placed by its folders. */
function load(
	store: RouteStore,
	Piece: typeof InstagramCallback | typeof TikTokCallback,
	file: string,
) {
	return new Piece({
		name: "callback.get",
		path: join(Root, file),
		root: Root,
		store,
	} as never);
}

function serves(store: RouteStore, path: string) {
	return store.router.find(RouterRoot.normalize(path))?.node.get("GET") ?? null;
}

describe("the OAuth callbacks", () => {
	let store: RouteStore;

	beforeEach(() => {
		container.server = { options: {} } as never;
		store = new RouteStore();
	});

	// Both files are named callback.get.ts. A store keeps one piece per name, so the second one
	// loaded used to unload the first, and its owners could never finish connecting.
	it("are both served, whichever is loaded last", async () => {
		await store.insert(
			load(store, InstagramCallback, "social/instagram/callback.get.ts"),
		);
		await store.insert(
			load(store, TikTokCallback, "social/tiktok/callback.get.ts"),
		);

		expect(serves(store, "/social/instagram/callback")).toBeInstanceOf(
			InstagramCallback,
		);
		expect(serves(store, "/social/tiktok/callback")).toBeInstanceOf(
			TikTokCallback,
		);
	});

	it("answer GET only, as the provider redirects there", async () => {
		const route = load(store, TikTokCallback, "social/tiktok/callback.get.ts");
		await store.insert(route);

		expect([...route.methods]).toStrictEqual(["GET"]);
	});
});
