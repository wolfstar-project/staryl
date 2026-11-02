import { setup as envRun } from "@wolfstar/env-utilities";
import { defineConfig, env } from "prisma/config";

envRun(new URL("./src/.env", import.meta.url));
export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: {
		path: "prisma/migrations",
	},
	datasource: {
		// The CLI changes the schema, which a pooler in transaction mode cannot be trusted with:
		// production reaches Postgres through PgBouncer, so it sets a direct URL for the CLI.
		url: process.env.DATABASE_DIRECT_URL || env("DATABASE_URL"),
	},
});
