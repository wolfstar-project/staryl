import { Result } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";

/** Counts every notification configured by the server, including social subscriptions. */
export function getSettingsSubscriptionCount(guildId: bigint) {
	return Result.fromAsync(async () => {
		const counts = await Promise.all([
			container.prisma.guildSubscription.count({ where: { guildId } }),
			container.prisma.guildSocialSubscription.count({ where: { guildId } }),
		]);
		return counts.reduce((total, count) => total + count, 0);
	});
}
