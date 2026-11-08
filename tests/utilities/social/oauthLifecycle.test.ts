import type { ConnectedAccountApi } from "#social/connectedAccounts";
import { finishSocialConnection } from "#social/connectedAccounts";
import { DefaultSocialFilters } from "#social/filters";
import { ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const apiMock = vi.hoisted(() => ({
	guilds: { get: vi.fn(), getMember: vi.fn(), getRoles: vi.fn() },
}));
const add = vi.hoisted(() => vi.fn());
vi.mock("#utils/discordApi", () => ({ api: () => apiMock }));
vi.mock("#social/subscriptions", () => ({ addSocialSubscription: add }));
const db = {
	socialOAuthState: { findUnique: vi.fn(), deleteMany: vi.fn() },
	socialConnection: { upsert: vi.fn() },
	socialSource: { updateMany: vi.fn() },
};
const grant = {
	accessToken: "private-access-token",
	accountId: "42",
	displayName: "Creator",
	expiresAt: Date.now() + 100_000,
};
const client: ConnectedAccountApi = {
	name: "Instagram",
	configured: true,
	redirectUri: "https://example.com/callback",
	refreshWindowMs: 1000,
	authorize: () => "",
	exchange: vi.fn(),
	refresh: vi.fn(),
	media: vi.fn(),
};
const state = "ab".repeat(32);
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("SOCIAL_TOKEN_KEY", "cd".repeat(32));
	container.prisma = db as never;
	db.socialOAuthState.findUnique.mockResolvedValue({
		id: "hash",
		provider: "Instagram",
		guildId: 1n,
		channelId: 2n,
		userId: "manager",
		expiresAt: new Date(Date.now() + 60000),
		filters: { ...DefaultSocialFilters, includeKeywords: ["release"] },
		message: null,
	});
	db.socialOAuthState.deleteMany.mockResolvedValue({ count: 1 });
	apiMock.guilds.get.mockResolvedValue({ owner_id: "manager" });
	vi.mocked(client.exchange).mockResolvedValue(ok(grant));
	add.mockResolvedValue(ok({ displayName: "Creator" }));
});
afterEach(() => vi.unstubAllEnvs());
it("consumes authorization once and carries keyword filters to the new subscription", async () => {
	expect(await finishSocialConnection(client, state, "code")).toBe(true);
	expect(add).toHaveBeenCalledWith(
		expect.objectContaining({
			guildId: 1n,
			channelId: 2n,
			input: "1:42",
			filters: expect.objectContaining({ includeKeywords: ["release"] }),
		}),
	);
	expect(
		db.socialConnection.upsert.mock.calls[0][0].create.credentials,
	).not.toContain("private-access-token");
});
it("refuses a replay before exchanging the code", async () => {
	db.socialOAuthState.deleteMany.mockResolvedValue({ count: 0 });
	expect(await finishSocialConnection(client, state, "code")).toBe(false);
	expect(client.exchange).not.toHaveBeenCalled();
});
it("rechecks Manage Server permission before accepting a grant", async () => {
	apiMock.guilds.get.mockResolvedValue({ owner_id: "someone-else" });
	apiMock.guilds.getMember.mockResolvedValue({ roles: [] });
	apiMock.guilds.getRoles.mockResolvedValue([]);
	expect(await finishSocialConnection(client, state, "code")).toBe(false);
	expect(client.exchange).not.toHaveBeenCalled();
});
it("rejects expired state without any token exchange", async () => {
	db.socialOAuthState.findUnique.mockResolvedValue({
		provider: "Instagram",
		expiresAt: new Date(0),
	});
	expect(await finishSocialConnection(client, state, "code")).toBe(false);
	expect(client.exchange).not.toHaveBeenCalled();
});
