import { PrismaClient } from "#generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { envParseString } from "@wolfstar/env-utilities";
import { container } from "@wolfstar/http-framework";

// No default: a missing URL stops the boot instead of reaching for a database that is not there.
const adapter = new PrismaPg({
	connectionString: envParseString("DATABASE_URL"),
});
const prisma = new PrismaClient({ adapter });
container.prisma = prisma;

export type {
	GuildSocialSubscription,
	GuildSubscription,
	Prisma,
	SocialDeliveryError,
	SocialFailure,
	SocialProviderName,
	SocialSource,
	SocialConnection,
	TwitchSubscription,
	TwitchSubscriptionType,
} from "#generated/prisma";

declare module "@sapphire/pieces" {
	interface Container {
		prisma: PrismaClient;
	}
}
