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
					author_id: "123",
					text: "Hello",
					referenced_tweets: [{ type: "replied_to" }],
					attachments: { media_keys: ["photo"] },
				},
			],
			includes: {
				users: [{ id: "123", protected: false }],
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
it.each([null, { sinceId: "19" }])(
	"reads only the newest page, including for large accounts: %j",
	async (state) => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				data: [{ id: "20", author_id: "123", text: "Q&amp;A &lt;3" }],
				meta: { next_token: "more-archive" },
				includes: { users: [{ id: "123", protected: false }] },
			}),
		);
		const result = await createXProvider({ fetch: request, env }).fetchLatest(
			"123",
			state,
		);
		expect(result.unwrap()).toMatchObject({
			items: [{ id: "20", text: "Q&A <3" }],
			state: { sinceId: "20" },
		});
		expect(request).toHaveBeenCalledTimes(1);
	},
);
it("stops forwarding posts when a previously public owner becomes protected", async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json({
			data: [{ id: "20", author_id: "123", text: "Private" }],
			includes: { users: [{ id: "123", protected: true }] },
		}),
	);
	expect(
		(
			await createXProvider({ fetch: request, env }).fetchLatest("123", {
				sinceId: "19",
			})
		).unwrapErr(),
	).toEqual({ _tag: "TargetUnavailable" });
});
it("marks sensitive posts for the shared NSFW channel filter", async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json({
			data: [
				{
					id: "20",
					author_id: "123",
					text: "Sensitive",
					possibly_sensitive: true,
				},
			],
			includes: { users: [{ id: "123", protected: false }] },
		}),
	);
	const result = (
		await createXProvider({ fetch: request, env }).fetchLatest("123", null)
	).unwrap();
	expect(result).toMatchObject({ items: [{ isNsfw: true }] });
});
it("reports an app-level 403 as a credential problem", async () => {
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response(null, { status: 403 }));
	expect(
		(
			await createXProvider({ fetch: request, env }).fetchLatest("123", null)
		).unwrapErr(),
	).toEqual({ _tag: "AuthFailed" });
	expect(
		(
			await createXProvider({ fetch: request, env }).validateTarget("@owner")
		).unwrapErr(),
	).toEqual({ _tag: "TargetUnreachable" });
});
it("keeps the full notification window during a background delivery retry", async () => {
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValue(Response.json({ data: [] }));
	await createXProvider({ fetch: request, env }).fetchLatest("123", null, {
		checkRequested: false,
	});
	expect(
		new URL(String(request.mock.calls[0][0])).searchParams.get("max_results"),
	).toBe("100");
});
it("shares the request budget between command previews and scheduled reads", async () => {
	const request = vi
		.fn<typeof fetch>()
		.mockImplementation(async () => Response.json({ data: [] }));
	const provider = createXProvider({ fetch: request, env });
	for (let i = 0; i < 15; i++) {
		// oxlint-disable-next-line no-await-in-loop -- exercise consecutive requests against one shared budget
		expect(
			(
				await provider.fetchLatest(
					"123",
					null,
					i % 2 ? { checkRequested: false } : undefined,
				)
			).isOk(),
		).toBe(true);
	}
	expect((await provider.fetchLatest("123", null)).unwrapErr()).toMatchObject({
		_tag: "RateLimited",
	});
	expect(request).toHaveBeenCalledTimes(15);
});
