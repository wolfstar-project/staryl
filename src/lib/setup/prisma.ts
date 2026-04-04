import { PrismaClient } from "#generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { container } from "@skyra/http-framework";

const adapter = new PrismaPg({
  connectionString: `${process.env.DATABASE_URL}`,
});
const prisma = new PrismaClient({ adapter });
container.prisma = prisma;

declare module "@sapphire/pieces" {
  interface Container {
    prisma: typeof prisma;
  }
}

export type {
  GuildSubscription,
  TwitchSubscription,
  TwitchSubscriptionType,
} from "#generated/prisma";
