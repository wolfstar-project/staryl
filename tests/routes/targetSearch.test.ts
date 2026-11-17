import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { err, ok } from "@sapphire/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserRoute } from "../../src/routes/guilds/[guild]/targets.get.ts";

const { providers } = vi.hoisted(() => {
	const searchable = (name: string, configured = true) => ({
		name,
		getAuthRequirements: () => ({ variables: [], satisfied: configured }),
		searchTargets: vi.fn(),
	});
	return {
		providers: {
			Bluesky: searchable("Bluesky"),
			Reddit: searchable("Reddit", false),
			TwitchVideos: searchable("TwitchVideos"),
			// RSS has no search: a feed is typed as a URL.
			Rss: {
				name: "Rss",
				getAuthRequirements: () => ({ variables: [], satisfied: true }),
			},
		} as Record<string, { searchTargets?: ReturnType<typeof vi.fn> }>,
	};
});

vi.mock("#social/registry", () => ({
	getSocialProvider: (name: string) => providers[name],
}));

const Secret = "a-secret-only-the-dashboard-knows";

async function search(query: Record<string, string>) {
	const answer = { status: 200, body: undefined as unknown };
	const response = {
		json(data: unknown) {
			answer.body = data;
		},
		error(code: number, data: unknown) {
			answer.status = code;
			answer.body = { error: data };
		},
	};
	const route = Object.create(UserRoute.prototype) as UserRoute;
	await route.run(
		{
			headers: { authorization: `Bearer ${Secret}` },
			params: { guild: "737141877803057244" },
			query,
		} as unknown as ApiRequest,
		response as unknown as ApiResponse,
	);
	return answer;
}

describe("GET /guilds/:guild/targets", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("GUILD_API_SECRET", Secret);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("suggests the accounts the provider finds", async () => {
		providers.Bluesky!.searchTargets!.mockResolvedValue(
			ok([{ name: "Bluesky (@bsky.app)", value: "bsky.app" }]),
		);

		const answer = await search({ source: "Bluesky", query: " bsky " });

		expect(answer).toEqual({
			status: 200,
			body: {
				suggestions: [{ name: "Bluesky (@bsky.app)", value: "bsky.app" }],
			},
		});
		expect(providers.Bluesky!.searchTargets).toHaveBeenCalledWith("bsky");
	});

	it("leaves out what the autocomplete leaves out, and cuts a long name as it does", async () => {
		const longName = "n".repeat(120);
		providers.Bluesky!.searchTargets!.mockResolvedValue(
			ok([
				{ name: "Too long", value: "v".repeat(101) },
				{ name: longName, value: "kept.example" },
			]),
		);

		const answer = await search({ source: "Bluesky", query: "kept" });

		expect(answer.body).toEqual({
			suggestions: [{ name: `${"n".repeat(99)}…`, value: "kept.example" }],
		});
	});

	// Twitch live follows a channel by its login, which the Twitch channel search gives.
	it("suggests Twitch channels for Twitch live", async () => {
		providers.TwitchVideos!.searchTargets!.mockResolvedValue(
			ok([{ name: "Shroud", value: "shroud" }]),
		);

		const answer = await search({ source: "TwitchLive", query: "shro" });

		expect(answer.body).toEqual({
			suggestions: [{ name: "Shroud", value: "shroud" }],
		});
	});

	it("answers the same search from the cache, so typing spends no more of the budget", async () => {
		providers.TwitchVideos!.searchTargets!.mockResolvedValue(
			ok([{ name: "Pokimane", value: "pokimane" }]),
		);

		await search({ source: "TwitchLive", query: "poki" });
		await search({ source: "TwitchLive", query: "POKI" });

		expect(providers.TwitchVideos!.searchTargets).toHaveBeenCalledOnce();
	});

	it.each([
		["a source without a search", { source: "Rss", query: "example" }],
		["a source without credentials", { source: "Reddit", query: "discordapp" }],
		["an unknown source", { source: "Myspace", query: "tom" }],
		["a query of one letter", { source: "Bluesky", query: "b" }],
		[
			"a query longer than any handle",
			{ source: "Bluesky", query: "b".repeat(101) },
		],
	])("suggests nothing for %s", async (_name, query) => {
		const answer = await search(query);

		expect(answer).toEqual({ status: 200, body: { suggestions: [] } });
	});

	it("suggests nothing when the search fails, so the member can still type it", async () => {
		providers.Bluesky!.searchTargets!.mockResolvedValue(
			err({ _tag: "Unavailable" }),
		);

		const answer = await search({ source: "Bluesky", query: "unreachable" });

		expect(answer).toEqual({ status: 200, body: { suggestions: [] } });
	});

	it("refuses a request without a source or a query", async () => {
		const answer = await search({ query: "bsky" });

		expect(answer).toEqual({ status: 400, body: { error: "invalid-query" } });
	});
});
