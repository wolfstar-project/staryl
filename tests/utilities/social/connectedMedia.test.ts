import type { ConnectedAccountApi } from "#social/connectedAccounts";
import { readConnectedMedia, sealSocialToken } from "#social/connectedAccounts";
import { err, ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const key = "ab".repeat(32);
const token = {
	accessToken: "current",
	refreshToken: "refresh",
	accountId: "42",
	displayName: "Creator",
	expiresAt: Date.now() + 3600000,
};
const db = { socialConnection: { findUnique: vi.fn(), updateMany: vi.fn() } };
const client: ConnectedAccountApi = {
	name: "Instagram",
	configured: true,
	redirectUri: "https://example.com/callback",
	refreshWindowMs: 7 * 86400000,
	authorize: () => "",
	exchange: vi.fn(),
	refresh: vi.fn(),
	media: vi.fn(),
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("SOCIAL_TOKEN_KEY", key);
	container.prisma = db as never;
	db.socialConnection.findUnique.mockResolvedValue({
		provider: "Instagram",
		target: "1:42",
		credentials: sealSocialToken(token, key),
	});
	db.socialConnection.updateMany.mockResolvedValue({ count: 1 });
	vi.mocked(client.refresh).mockResolvedValue(err({ _tag: "Unavailable" }));
	vi.mocked(client.media).mockResolvedValue(ok([]));
});
afterEach(() => vi.unstubAllEnvs());
it("continues reading with a valid token after a transient refresh failure", async () => {
	expect((await readConnectedMedia(client, "1:42")).isOk()).toBe(true);
	expect(client.media).toHaveBeenCalledWith(token);
});
it("continues reading while another worker owns the refresh lease", async () => {
	db.socialConnection.updateMany.mockResolvedValue({ count: 0 });
	expect((await readConnectedMedia(client, "1:42")).isOk()).toBe(true);
	expect(client.refresh).not.toHaveBeenCalled();
	expect(client.media).toHaveBeenCalledWith(token);
});
it("surfaces refresh failure once the current token has expired", async () => {
	db.socialConnection.findUnique.mockResolvedValue({
		provider: "Instagram",
		target: "1:42",
		credentials: sealSocialToken({ ...token, expiresAt: 0 }, key),
	});
	vi.mocked(client.refresh).mockResolvedValue(err({ _tag: "AuthFailed" }));
	expect((await readConnectedMedia(client, "1:42")).unwrapErr()).toEqual({
		_tag: "AuthFailed",
	});
	expect(client.media).not.toHaveBeenCalled();
});
it("treats lost keys and corrupt envelopes as a reconnection problem", async () => {
	vi.stubEnv("SOCIAL_TOKEN_KEY", "cd".repeat(32));
	expect((await readConnectedMedia(client, "1:42")).unwrapErr()).toEqual({
		_tag: "AuthFailed",
	});
	expect(client.refresh).not.toHaveBeenCalled();
	expect(client.media).not.toHaveBeenCalled();
});
it("does not deliver with an expired token whose refresh was superseded", async () => {
	db.socialConnection.findUnique.mockResolvedValue({
		provider: "Instagram",
		target: "1:42",
		credentials: sealSocialToken({ ...token, expiresAt: 0 }, key),
	});
	db.socialConnection.updateMany
		.mockResolvedValueOnce({ count: 1 })
		.mockResolvedValueOnce({ count: 0 });
	vi.mocked(client.refresh).mockResolvedValue(
		ok({ ...token, accessToken: "renewed" }),
	);
	expect((await readConnectedMedia(client, "1:42")).unwrapErr()).toEqual({
		_tag: "AuthFailed",
	});
	expect(client.media).not.toHaveBeenCalled();
});
