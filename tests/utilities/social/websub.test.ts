import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import {
	extractChannelIds,
	getCallbackToken,
	getChannelTopic,
	isValidHubSignature,
	parseTopicChannelId,
} from "#social/websub";
import { container } from "@wolfstar/http-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserRoute as VerifyRoute } from "../../../src/routes/youtube/websub.get.ts";
import { UserRoute as PushRoute } from "../../../src/routes/youtube/websub.post.ts";

const ChannelId = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
const Secret = "secret";
const Body = `<feed><entry><yt:channelId>${ChannelId}</yt:channelId></entry></feed>`;

function sign(body: string, secret = Secret, algorithm = "sha1") {
	const digest = createHmac(algorithm, secret).update(body).digest("hex");
	return `${algorithm}=${digest}`;
}

const prismaMock = {
	socialSource: { count: vi.fn(), updateMany: vi.fn() },
};

function makeResponse() {
	const response = {
		statusCode: 200,
		body: null as string | null,
		text(data: string) {
			response.body = data;
		},
		status(code: number) {
			response.statusCode = code;
			return response;
		},
	};
	return response;
}

/** Routes are thin, so they run without a server: `container` is all they reach for. */
function run(
	Route: typeof VerifyRoute | typeof PushRoute,
	request: Partial<ApiRequest> & { query?: Record<string, string> },
) {
	const response = makeResponse();
	const route = Object.create(Route.prototype) as VerifyRoute;
	return route
		.run(request as ApiRequest, response as unknown as ApiResponse)
		.then(() => response);
}

beforeEach(() => {
	vi.clearAllMocks();
	container.prisma = prismaMock as never;
	vi.stubEnv(
		"YOUTUBE_WEBSUB_CALLBACK",
		"https://staryl.example/youtube/websub",
	);
	vi.stubEnv("YOUTUBE_WEBSUB_SECRET", Secret);
	prismaMock.socialSource.count.mockResolvedValue(1);
	prismaMock.socialSource.updateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("parseTopicChannelId", () => {
	it("reads the channel of its own topic URL", () => {
		expect(parseTopicChannelId(getChannelTopic(ChannelId))).toBe(ChannelId);
	});

	it.each([
		"https://www.youtube.com/xml/feeds/videos.xml?channel_id=nope",
		"https://example.com/feed",
		undefined,
		["a"],
	])("refuses %j", (topic) => {
		expect(parseTopicChannelId(topic)).toBeNull();
	});
});

describe("isValidHubSignature", () => {
	it.each(["sha1", "sha256", "sha512"])("accepts a good %s", (algorithm) => {
		const header = sign(Body, Secret, algorithm);

		expect(isValidHubSignature(Secret, header, Body)).toBe(true);
	});

	it.each([
		["another secret", sign(Body, "other")],
		["another body", sign("other")],
		["a weak algorithm", sign(Body, Secret, "md5")],
		["no value", "sha1="],
		["junk", "not a signature"],
		["a missing header", undefined],
	])("refuses %s", (_, header) => {
		expect(isValidHubSignature(Secret, header, Body)).toBe(false);
	});
});

describe("extractChannelIds", () => {
	it("finds each channel once", () => {
		expect(extractChannelIds(`${Body}${Body}`)).toEqual([ChannelId]);
	});

	it("ignores anything else", () => {
		expect(extractChannelIds("<feed/>")).toEqual([]);
	});
});

describe("GET /youtube/websub", () => {
	const query = {
		"hub.mode": "subscribe",
		"hub.topic": getChannelTopic(ChannelId),
		"hub.challenge": "abc123",
		token: getCallbackToken(Secret, ChannelId),
	};

	it("echoes the challenge for a channel a server follows", async () => {
		const response = await run(VerifyRoute, { query });

		expect(response.body).toBe("abc123");
		expect(response.statusCode).toBe(200);
	});

	it.each([
		["a channel nobody follows", query, 0],
		[
			"an unsubscribe nobody asked for",
			{ ...query, "hub.mode": "unsubscribe" },
			1,
		],
		["another topic", { ...query, "hub.topic": "https://example.com" }, 1],
		["no challenge", { ...query, "hub.challenge": undefined }, 1],
		[
			"a subscription someone else asked for",
			{ ...query, token: undefined },
			1,
		],
		[
			"a token for another channel",
			{ ...query, token: getCallbackToken(Secret, "UCother") },
			1,
		],
	])("refuses %s", async (_, request, followers) => {
		prismaMock.socialSource.count.mockResolvedValue(followers);

		const response = await run(VerifyRoute, { query: request as never });

		expect(response.statusCode).toBe(404);
		expect(response.body).not.toBe("abc123");
	});

	it("refuses everything when WebSub is not configured", async () => {
		vi.stubEnv("YOUTUBE_WEBSUB_SECRET", "");

		const response = await run(VerifyRoute, { query });

		expect(response.statusCode).toBe(404);
	});
});

describe("POST /youtube/websub", () => {
	const push = (body: string, signature?: string) =>
		run(
			PushRoute,
			Object.assign(Readable.from([Buffer.from(body)]), {
				headers: { "x-hub-signature": signature },
			}) as never,
		);

	it("makes a followed channel due, without posting anything itself", async () => {
		await push(Body, sign(Body));

		expect(prismaMock.socialSource.updateMany).toHaveBeenCalledWith({
			where: { provider: "YouTube", target: ChannelId },
			data: { nextCheckAt: expect.any(Date) },
		});
	});

	it("answers success to a forged push, and does nothing with it", async () => {
		vi.spyOn(container.logger, "warn").mockImplementation(() => undefined);

		const response = await push(Body, sign(Body, "forged"));

		expect(response.statusCode).toBe(200);
		expect(prismaMock.socialSource.updateMany).not.toHaveBeenCalled();
	});

	it("stops reading a push far larger than any real one", async () => {
		const huge = `${Body}${"x".repeat(1024 * 1024)}`;

		const response = await push(huge, sign(huge));

		expect(response.statusCode).toBe(200);
		expect(prismaMock.socialSource.updateMany).not.toHaveBeenCalled();
	});
});
