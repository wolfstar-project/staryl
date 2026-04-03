import { PrismaClient } from "@prisma/client";
import { container } from "@skyra/http-framework";

const prisma = new PrismaClient();
container.prisma = prisma;

declare module "@sapphire/pieces" {
  interface Container {
    prisma: typeof prisma;
  }
}

export type { GuildSubscription, TwitchSubscription, TwitchSubscriptionType } from "@prisma/client";
