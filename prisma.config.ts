import { setup as envRun } from "@wolfstar/env-utilities";
import { defineConfig, env } from "prisma/config";

envRun(new URL("./src/.env", import.meta.url));
export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: {
		path: "prisma/migrations",
	},
	datasource: {
		url: env("DATABASE_URL"),
	},
});
