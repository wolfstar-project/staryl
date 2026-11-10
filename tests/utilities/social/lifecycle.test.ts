import { DefaultSocialFilters } from "#social/filters";
import { addSocialSubscription } from "#social/subscriptions";
import { ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ saved: false }));
const provider = vi.hoisted(() => ({
	name: "YouTube",
	checkIntervalMs: 1000,
	supportedFilters: new Set(),
	getAuthRequirements: () => ({ satisfied: true, variables: [] }),
	validateTarget: vi.fn(),
	fetchLatest: vi.fn(),
	onSubscribed: vi.fn(),
}));
vi.mock("#social/registry", () => ({
	getSocialProvider: () => provider,
	SocialProviders: [provider],
}));
it("saves the baseline before a hub can verify the new source", async () => {
	state.saved = false;
	provider.validateTarget.mockResolvedValue(
		ok({ target: "channel", displayName: "Channel" }),
	);
	provider.fetchLatest.mockResolvedValue(
		ok({ _tag: "Items", items: [], state: null }),
	);
	provider.onSubscribed.mockImplementation(async () => {
		expect(state.saved).toBe(true);
		return ok(undefined);
	});
	container.prisma = {
		guildSocialSubscription: {
			count: vi.fn().mockResolvedValue(0),
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn().mockImplementation(async () => {
				state.saved = true;
				return {};
			}),
		},
	} as never;
	const result = await addSocialSubscription({
		guildId: 1n,
		channelId: 2n,
		providerName: "YouTube",
		input: "channel",
		message: null,
		filters: DefaultSocialFilters,
	});
	expect(result.isOk()).toBe(true);
	expect(provider.onSubscribed).toHaveBeenCalledWith("channel");
});
