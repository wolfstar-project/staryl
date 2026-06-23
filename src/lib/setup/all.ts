import { envParseString, setup as envRun } from "@wolfstar/env-utilities";
import {
	initializeSentry,
	setInvite,
	setRepository,
} from "@wolfstar/shared-http-pieces";
/* oxlint-disable import/first */
import "#lib/setup/logger";
import "#lib/setup/prisma";
import "#lib/setup/fastify";
import "@wolfstar/shared-http-pieces/register";

export async function setup() {
	envRun(new URL("../../../src/.env", import.meta.url));

	setRepository("staryl");
	setInvite(envParseString("DISCORD_CLIENT_ID"), "0");
	initializeSentry();

	// Load all routes
	await import("#api/routes/_load");
}
