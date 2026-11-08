import { DefaultSocialFilters } from "#social/filters";
import { addSocialSubscription } from "#social/subscriptions";
import { ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { expect, it, vi } from "vitest";
const provider = vi.hoisted(() => ({
	name: "Instagram",
	supportedFilters: new Set(),
	getAuthRequirements: () => ({ satisfied: true, variables: [] }),
	validateTarget: vi.fn(),
	fetchLatest: vi.fn(),
}));
vi.mock("#social/registry", () => ({
	getSocialProvider: () => provider,
	SocialProviders: [provider],
}));
it("blocks subscriptions to credentials owned by another guild before reading media", async () => {
	provider.validateTarget.mockResolvedValue(
		ok({ target: "2:42", displayName: "Other guild" }),
	);
	container.prisma = {
		guildSocialSubscription: { count: vi.fn().mockResolvedValue(0) },
	} as never;
	const result = await addSocialSubscription({
		guildId: 1n,
		channelId: 3n,
		providerName: "Instagram",
		input: "2:42",
		message: null,
		filters: DefaultSocialFilters,
	});
	expect(result.unwrapErr()).toBe("commands/social:addTargetBlocked");
	expect(provider.fetchLatest).not.toHaveBeenCalled();
});
