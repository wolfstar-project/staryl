import { envParseString, setup as envRun } from "@wolfstar/env-utilities";
import {
	initializeSentry,
	setInvite,
	setRepository,
} from "@wolfstar/shared-http-pieces";
import "@wolfstar/plugin-logger/register";
import "@wolfstar/plugin-api/register";
import "@wolfstar/plugin-i18next/register";
import "@wolfstar/plugin-subcommands-advanced/register";
import "#lib/setup/prisma";
import "@wolfstar/shared-http-pieces/register";

export async function initializeApp() {
	envRun(new URL("../../../src/.env", import.meta.url));

	setRepository("staryl");
	setInvite(envParseString("DISCORD_CLIENT_ID"), "0");
	initializeSentry();
}
