import { PrismaClient } from "#generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { container } from "@skyra/http-framework";

interface GetDbParams {
  connectionString: string;
}

function getDb({ connectionString }: GetDbParams) {
  const pool = new PrismaPg({ connectionString });

  const prisma = new PrismaClient({ adapter: pool });

  return prisma;
}
const connectionString = `${process.env.DATABASE_URL}`;
const prisma = getDb({ connectionString });
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
