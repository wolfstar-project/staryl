import {
	createTikTokApi,
	createTikTokProvider,
} from "#social/providers/tiktok";
import { expect, it, vi } from "vitest";
const env = {
	TIKTOK_CLIENT_KEY: "key",
	TIKTOK_CLIENT_SECRET: "secret",
	TIKTOK_REDIRECT_URI: "https://bot.example/social/tiktok/callback",
	TIKTOK_APP_APPROVED: "true",
	SOCIAL_TOKEN_KEY: "ab".repeat(32),
};
const token = {
	accessToken: "old",
	refreshToken: "refresh-old",
	accountId: "owner",
	displayName: "Creator",
	expiresAt: 0,
};
it("keeps an unapproved developer app unavailable", () => {
	expect(
		createTikTokProvider({
			env: { ...env, TIKTOK_APP_APPROVED: "false" },
		}).getAuthRequirements().satisfied,
	).toBe(false);
});
it("retains the rotated refresh token and the returned access expiry", async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json({
			access_token: "new",
			refresh_token: "refresh-new",
			open_id: "owner",
			expires_in: 7200,
			scope: "user.info.basic,video.list",
		}),
	);
	const result = await createTikTokApi({
		env,
		fetch: request,
		now: () => 1000,
	}).refresh(token);
	expect(result.unwrap()).toMatchObject({
		accessToken: "new",
		refreshToken: "refresh-new",
		expiresAt: 7201000,
	});
	expect(String(request.mock.calls[0][1]?.body)).toContain(
		"refresh_token=refresh-old",
	);
});
it("surfaces an API error returned with HTTP 200", async () => {
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValue(
			Response.json({ error: { code: "access_token_invalid" } }),
		);
	expect(
		(await createTikTokApi({ env, fetch: request }).media(token)).unwrapErr(),
	).toEqual({ _tag: "AuthFailed" });
});
it("uses stable video IDs and a cover image", async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json({
			data: {
				videos: [
					{
						id: "42",
						title: "Video",
						video_description: "Caption",
						share_url: "https://www.tiktok.com/@creator/video/42",
						cover_image_url: "https://example.com/cover.jpg",
						create_time: 100,
					},
				],
			},
			error: { code: "ok" },
		}),
	);
	const result = await createTikTokApi({ env, fetch: request }).media(token);
	expect(result.unwrap()).toMatchObject([
		{ id: "42", text: "Caption", imageUrl: "https://example.com/cover.jpg" },
	]);
});
it.each([undefined, {}, { display_name: "" }])(
	"falls back to the owner ID when profile fields are absent: %j",
	async (user) => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					access_token: "access",
					refresh_token: "refresh",
					open_id: "owner",
					expires_in: 7200,
					scope: "user.info.basic,video.list",
				}),
			)
			.mockResolvedValueOnce(
				Response.json({ data: { user }, error: { code: "ok" } }),
			);
		expect(
			(
				await createTikTokApi({ fetch: request, env }).exchange("code")
			).unwrap(),
		).toMatchObject({ accountId: "owner", displayName: "owner" });
	},
);
it("requires reconnection for a rejected refresh grant", async () => {
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValue(
			Response.json(
				{ error: "invalid_grant", error_description: "Refresh token expired" },
				{ status: 400 },
			),
		);
	expect(
		(await createTikTokApi({ fetch: request, env }).refresh(token)).unwrapErr(),
	).toEqual({ _tag: "AuthFailed" });
});
it("keeps token endpoint outages retryable", async () => {
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValue(
			Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
		);
	expect(
		(await createTikTokApi({ fetch: request, env }).refresh(token)).unwrapErr(),
	).toEqual({ _tag: "Unavailable" });
});
