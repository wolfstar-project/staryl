import { DefaultLimits, readGuildLimits } from "#utils/ring";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

function ringAnswers(status: number, body: unknown) {
	fetchMock.mockResolvedValue(
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
}

describe("readGuildLimits", () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		vi.stubEnv("INTERNAL_RING_URL", "https://ring.test/guilds");
		vi.stubEnv("INTERNAL_RING_TOKEN", "ring-token");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("gives a guild the free values when Ring is not set up", async () => {
		vi.stubEnv("INTERNAL_RING_URL", "");

		await expect(readGuildLimits(1n)).resolves.toStrictEqual(DefaultLimits);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("asks Ring for the guild with Staryl's token", async () => {
		ringAnswers(200, {
			maximumYouTubeSubscriptions: 20,
			maximumTwitchSubscriptions: 25,
			maximumRedditSubscriptions: 45,
		});

		await expect(readGuildLimits(737141877803057244n)).resolves.toStrictEqual({
			maximumYouTubeSubscriptions: 20,
			maximumTwitchSubscriptions: 25,
			maximumRedditSubscriptions: 45,
		});
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(String(url)).toBe("https://ring.test/guilds/737141877803057244");
		expect(
			new Headers((init as RequestInit).headers).get("authorization"),
		).toBe("ring-token");
	});

	// A Ring from before the Reddit limit answers without it.
	it("fills a limit Ring does not send with its free value", async () => {
		ringAnswers(200, {
			maximumYouTubeSubscriptions: 20,
			maximumTwitchSubscriptions: "lots",
		});

		await expect(readGuildLimits(1n)).resolves.toStrictEqual({
			maximumYouTubeSubscriptions: 20,
			maximumTwitchSubscriptions: DefaultLimits.maximumTwitchSubscriptions,
			maximumRedditSubscriptions: DefaultLimits.maximumRedditSubscriptions,
		});
	});

	it.each([
		["answers null", () => ringAnswers(200, null)],
		["answers a list", () => ringAnswers(200, [20, 25])],
		["answers an error", () => ringAnswers(500, { success: false })],
		[
			"cannot be reached",
			() => fetchMock.mockRejectedValue(new TypeError("fetch failed")),
		],
	])("gives a guild the free values when Ring %s", async (_name, arrange) => {
		arrange();

		await expect(readGuildLimits(1n)).resolves.toStrictEqual(DefaultLimits);
	});
});
