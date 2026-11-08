import { DefaultSocialFilters } from "#social/filters";
import { addSocialSubscription } from "#social/subscriptions";
import { ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { expect, it, vi } from "vitest";
const provider = vi.hoisted(() => ({
	name: "X",
	checkIntervalMs: 1000,
	supportedFilters: new Set(),
	getAuthRequirements: () => ({ satisfied: true, variables: [] }),
	validateTarget: vi.fn(),
	fetchLatest: vi.fn(),
}));
vi.mock("#social/registry", () => ({
	getSocialProvider: () => provider,
	SocialProviders: [provider],
}));
it.each([
	["new-account", false],
	["first-account", true],
])(
	"enforces two distinct accounts inside the transaction: %s",
	async (target, allowed) => {
		provider.validateTarget.mockResolvedValue(
			ok({ target, displayName: target }),
		);
		provider.fetchLatest.mockResolvedValue(
			ok({ _tag: "Items", items: [], state: null }),
		);
		const create = vi.fn().mockResolvedValue({});
		const tx = {
			$queryRaw: vi.fn(),
			guildSocialSubscription: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ source: { provider: "X", target: "first-account" } },
						{ source: { provider: "X", target: "second-account" } },
					]),
				create,
			},
		};
		container.prisma = {
			guildSocialSubscription: {
				count: vi.fn().mockResolvedValue(2),
				findFirst: vi.fn().mockResolvedValue(null),
			},
			$transaction: vi.fn((callback) => callback(tx)),
		} as never;
		const result = await addSocialSubscription({
			guildId: 1n,
			channelId: 2n,
			providerName: "X",
			input: target,
			message: null,
			filters: DefaultSocialFilters,
		});
		expect(result.isOk()).toBe(allowed);
		expect(create).toHaveBeenCalledTimes(allowed ? 1 : 0);
		if (!allowed)
			expect(result.unwrapErr()).toBe("commands/social:addLimitReached");
	},
);
