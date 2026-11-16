import { setup as envRun } from "@wolfstar/env-utilities";
import { defineConfig } from "prisma/config";

envRun(new URL("./src/.env", import.meta.url));
export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: {
		path: "prisma/migrations",
	},
	datasource: {
		// The CLI changes the schema, which a pooler in transaction mode cannot be trusted with:
		// production reaches Postgres through PgBouncer, so it sets a direct URL for the CLI.
		// `prisma generate` needs no URL, so a missing one only fails the commands that connect.
		url: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL,
	},
});
