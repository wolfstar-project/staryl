import { envParseString, setup as envRun } from "@wolfstar/env-utilities";
import {
	initializeSentry,
	setInvite,
	setRepository,
} from "@wolfstar/shared-http-pieces";
import { PermissionFlagsBits } from "discord-api-types/v10";
import "#lib/setup/prisma";
import "#lib/setup/api";
import "@wolfstar/shared-http-pieces/register";

/**
 * The permissions the invite link asks for: what a notification needs in its channel. The bot only posts messages
 * (`channels.createMessage`), with no files, and it never edits or reads them.
 */
const InvitePermissions =
	PermissionFlagsBits.ViewChannel |
	PermissionFlagsBits.SendMessages |
	PermissionFlagsBits.EmbedLinks;

export async function initializeApp() {
	envRun(new URL("../../../src/.env", import.meta.url));

	setRepository("staryl");
	setInvite(envParseString("DISCORD_CLIENT_ID"), InvitePermissions.toString());
	initializeSentry();
}
