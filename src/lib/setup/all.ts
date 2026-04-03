/* oxlint-disable import/first */
import { setup as envRun } from "@skyra/env-utilities";
import {
  initializeSentry,
  setInvite,
  setRepository,
} from "@skyra/shared-http-pieces";
import "@skyra/shared-http-pieces/register";

envRun(new URL("../../../src/.env", import.meta.url));
setRepository("https://github.com/wolstar-project/starly");
setInvite("12345678906342567", "0");
initializeSentry();

import "#lib/setup/fastify";
import "#lib/setup/logger";
import "#lib/setup/prisma";
import "#lib/setup/i18n";
import "#lib/setup/schedules";

export async function setup() {
  // Load all routes
  await import("#api/routes/_load");
}
