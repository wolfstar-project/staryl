import { setup as envRun } from '@skyra/env-utilities';
import { initializeSentry, setInvite, setRepository } from '@skyra/shared-http-pieces';

import '@skyra/shared-http-pieces/register';

envRun(new URL('../../../src/.env', import.meta.url));
setRepository('starly');
setInvite('12345678906342567', '0');
initializeSentry();

import '#lib/setup/fastify';
import '#lib/setup/logger';
import '#lib/setup/prisma';

export function setup() {
	await import('#api/routes/_load');
}
