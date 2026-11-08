import { sealSocialToken, openSocialToken } from "#social/connectedAccounts";
import { createInstagramApi } from "#social/providers/instagram";
import { expect, it, vi } from "vitest";
const env = {
	INSTAGRAM_APP_ID: "id",
	INSTAGRAM_APP_SECRET: "secret",
	INSTAGRAM_REDIRECT_URI: "https://bot.example/social/instagram/callback",
	SOCIAL_TOKEN_KEY: "ab".repeat(32),
};
const token = {
	accessToken: "sensitive",
	accountId: "42",
	displayName: "Creator",
	expiresAt: 200_000,
};
it("stores credentials in authenticated ciphertext", () => {
	const sealed = sealSocialToken(token, env.SOCIAL_TOKEN_KEY);
	expect(sealed).not.toContain("sensitive");
	expect(openSocialToken(sealed, env.SOCIAL_TOKEN_KEY)).toEqual(token);
	expect(() => openSocialToken(sealed, "cd".repeat(32))).toThrow();
});
it("exchanges the code, rejects consumer accounts and keeps the owner identity", async () => {
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(Response.json({ access_token: "short" }))
		.mockResolvedValueOnce(
			Response.json({ access_token: "long", expires_in: 5184000 }),
		)
		.mockResolvedValueOnce(
			Response.json({
				user_id: "42",
				username: "Creator",
				account_type: "BUSINESS",
			}),
		);
	const result = await createInstagramApi({
		fetch: request,
		env,
		now: () => 1000,
	}).exchange("code");
	expect(result.unwrap()).toMatchObject({
		accountId: "42",
		accessToken: "long",
		expiresAt: 5184001000,
	});
	expect(String(request.mock.calls[0][1]?.body)).toContain(
		"redirect_uri=https%3A%2F%2Fbot.example",
	);
});
it("uses the video preview for reels rather than attaching an mp4 as an image", async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json({
			data: [
				{
					id: "1",
					caption: "caption",
					media_type: "VIDEO",
					media_product_type: "REELS",
					media_url: "https://example.com/video.mp4",
					thumbnail_url: "https://example.com/preview.jpg",
					permalink: "https://www.instagram.com/reel/1/",
				},
			],
		}),
	);
	const result = await createInstagramApi({ fetch: request, env }).media(token);
	expect(result.unwrap()).toMatchObject([
		{
			id: "1",
			title: "Reel",
			imageUrl: "https://example.com/preview.jpg",
			text: "caption",
		},
	]);
});
it("refreshes a long lived grant and honours the returned expiry", async () => {
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValue(
			Response.json({ access_token: "renewed", expires_in: 5184000 }),
		);
	expect(
		(
			await createInstagramApi({
				fetch: request,
				env,
				now: () => 1000,
			}).refresh(token)
		).unwrap(),
	).toMatchObject({ accessToken: "renewed", expiresAt: 5184001000 });
});
