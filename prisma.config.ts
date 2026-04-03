import { defineConfig, env } from "prisma/config";
// oxlint-disable-next-line import/no-unassigned-import
import "dotenv/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
