import { createXProvider } from "#social/providers/x";
import { expect, it, vi } from "vitest";
const env = {
	X_API_KEY: "key",
	X_API_SECRET: "secret",
	X_ACCESS_TOKEN: "token",
	X_ACCESS_SECRET: "secret",
};
it("requests only new posts and exposes reply/repost traits to shared filters", async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json({
			data: [
				{
					id: "20",
					text: "Hello",
					referenced_tweets: [{ type: "replied_to" }],
					attachments: { media_keys: ["photo"] },
				},
			],
			includes: {
				media: [{ media_key: "photo", url: "https://example.com/photo.jpg" }],
			},
		}),
	);
	const result = await createXProvider({ fetch: request, env }).fetchLatest(
		"123",
		{ sinceId: "19" },
	);
	expect(String(request.mock.calls[0][0])).toContain("since_id=19");
	expect(result.unwrap()).toMatchObject({
		items: [
			{ id: "20", isReply: true, imageUrl: "https://example.com/photo.jpg" },
		],
		state: { sinceId: "20" },
	});
});
it("rejects private accounts without creating a source", async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json({
			data: { id: "1", username: "private", protected: true },
		}),
	);
	expect(
		(
			await createXProvider({ fetch: request, env }).validateTarget("@private")
		).unwrapErr(),
	).toEqual({ _tag: "TargetBlocked" });
});
it("keeps revoked credentials visible as a provider failure", async () => {
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response(null, { status: 401 }));
	expect(
		(
			await createXProvider({ fetch: request, env }).fetchLatest("1", null)
		).unwrapErr(),
	).toEqual({ _tag: "AuthFailed" });
});
