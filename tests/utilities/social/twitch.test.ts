import {
	createTwitchClipsProvider,
	createTwitchVideosProvider,
} from "#social/providers/twitch";
import { err, ok } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@wolfstar/twitch-helpers", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@wolfstar/twitch-helpers")>();
	return {
		...actual,
		areTwitchClientCredentialsSet: vi.fn(),
		fetchUsers: vi.fn(),
		getRequest: vi.fn(),
	};
});

const { areTwitchClientCredentialsSet, fetchUsers, getRequest } =
	await import("@wolfstar/twitch-helpers");

const Target = "123456789";
const Now = Date.UTC(2026, 10, 1, 12);

const Video = {
	id: "1",
	title: "Finished stream",
	description: "",
	url: "https://www.twitch.tv/videos/1",
	user_name: "CoolStreamer",
	thumbnail_url:
		"https://static-cdn.jtvnw.net/cf_vods/x/thumb0-%{width}x%{height}.jpg",
	published_at: "2026-11-01T10:00:00Z",
};

const Clip = {
	id: "CleverClip",
	title: "What a play",
	url: "https://clips.twitch.tv/CleverClip",
	creator_name: "fan",
	thumbnail_url: "https://clips-media.twitch.tv/preview.jpg",
	created_at: "2026-11-01T10:00:00Z",
};

const videos = createTwitchVideosProvider();
const clips = createTwitchClipsProvider(() => Now);

function respond(...data: object[]) {
	vi.mocked(getRequest).mockResolvedValueOnce(ok({ data }) as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(areTwitchClientCredentialsSet).mockReturnValue(true);
});

describe("getAuthRequirements", () => {
	it("follows the Twitch client credentials", () => {
		vi.mocked(areTwitchClientCredentialsSet).mockReturnValue(false);

		expect(videos.getAuthRequirements().satisfied).toBe(false);
	});
});

describe("validateTarget", () => {
	it.each([
		"CoolStreamer",
		"https://twitch.tv/CoolStreamer",
		"https://www.twitch.tv/CoolStreamer/",
		"twitch.tv/coolstreamer",
	])("resolves %s to the user id", async (input) => {
		vi.mocked(fetchUsers).mockResolvedValueOnce(
			ok({ data: [{ id: Target, display_name: "CoolStreamer" }] }) as never,
		);

		const result = await videos.validateTarget(input);

		expect(result.unwrap()).toEqual({
			target: Target,
			displayName: "CoolStreamer",
		});
		expect(fetchUsers).toHaveBeenCalledWith({ logins: ["coolstreamer"] });
	});

	it("refuses what cannot be a login", async () => {
		const result = await videos.validateTarget("not a login");

		expect(result.unwrapErr()).toEqual({ _tag: "InvalidTarget" });
		expect(fetchUsers).not.toHaveBeenCalled();
	});

	it("reports a channel that does not exist", async () => {
		vi.mocked(fetchUsers).mockResolvedValueOnce(ok({ data: [] }) as never);

		const result = await videos.validateTarget("nobody123");

		expect(result.unwrapErr()).toEqual({ _tag: "TargetNotFound" });
	});

	it("reports Twitch being unreachable", async () => {
		vi.mocked(fetchUsers).mockRejectedValueOnce(new Error("no credentials"));

		const result = await videos.validateTarget("coolstreamer");

		expect(result.unwrapErr()).toEqual({ _tag: "TargetUnreachable" });
	});
});

describe("videos", () => {
	it("maps a finished video", async () => {
		respond(Video);

		const result = await videos.fetchLatest(Target, null);

		expect(result.unwrap()).toMatchObject({
			_tag: "Items",
			items: [
				{
					id: "1",
					url: Video.url,
					title: "Finished stream",
					text: null,
					imageUrl:
						"https://static-cdn.jtvnw.net/cf_vods/x/thumb0-1280x720.jpg",
					publishedAt: new Date(Video.published_at),
				},
			],
		});
	});

	it.each([
		["still recording", ""],
		[
			"still processing",
			"https://vod-secure.twitch.tv/_404/404_processing_%{width}x%{height}.png",
		],
	])("waits for a video that is %s", async (_, thumbnail_url) => {
		respond({ ...Video, thumbnail_url });

		const result = await videos.fetchLatest(Target, null);

		expect(result.unwrap()).toMatchObject({ items: [] });
	});

	it("reports a Twitch failure", async () => {
		vi.mocked(getRequest).mockResolvedValueOnce(
			err({ code: 500, response: new Response() }) as never,
		);

		const result = await videos.fetchLatest(Target, null);

		expect(result.unwrapErr()).toEqual({ _tag: "Unavailable" });
	});

	it("passes on how long a rate limit lasts", async () => {
		vi.mocked(getRequest).mockResolvedValueOnce(
			err({
				code: 429,
				response: new Response(null, { headers: { "retry-after": "30" } }),
			}) as never,
		);

		const result = await videos.fetchLatest(Target, null);

		expect(result.unwrapErr()).toEqual({
			_tag: "RateLimited",
			retryAfterMs: 30_000,
		});
	});

	it("reports an unexpected shape", async () => {
		vi.mocked(getRequest).mockResolvedValueOnce(ok({}) as never);

		const result = await videos.fetchLatest(Target, null);

		expect(result.unwrapErr()).toEqual({ _tag: "InvalidResponse" });
	});
});

describe("clips", () => {
	it("asks for a short window, since Helix ranks clips by views", async () => {
		respond();

		await clips.fetchLatest(Target, null);

		const since = new Date(Now - Time.Hour * 2).toISOString();
		expect(vi.mocked(getRequest).mock.calls[0][0]).toContain(
			`started_at=${encodeURIComponent(since)}`,
		);
	});

	it("sorts by date, which Helix does not", async () => {
		const older = { ...Clip, id: "older", created_at: "2026-11-01T09:00:00Z" };
		respond(older, Clip);

		const result = await clips.fetchLatest(Target, null);

		expect(result.unwrap()).toMatchObject({
			items: [{ id: "CleverClip" }, { id: "older" }],
		});
	});

	it("maps a clip", async () => {
		respond(Clip);

		const result = await clips.fetchLatest(Target, null);

		expect(result.unwrap()).toMatchObject({
			items: [
				{
					title: "What a play",
					authorName: "fan",
					imageUrl: Clip.thumbnail_url,
				},
			],
		});
	});
});

describe("rateLimitScope", () => {
	it("shares one budget across videos and clips, as Helix counts per token", () => {
		expect(videos.rateLimitScope("1")).toBe(clips.rateLimitScope("2"));
	});
});
