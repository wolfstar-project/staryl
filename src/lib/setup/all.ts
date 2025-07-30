import '#lib/setup/logger';
import '#lib/setup/prisma';
import { setup as envRun } from '@skyra/env-utilities';
import { initializeSentry, setInvite, setRepository } from '@skyra/shared-http-pieces';

import '#lib/setup/canvas';
import '#lib/setup/i18next';
import '#lib/setup/schedules';
import '@skyra/shared-http-pieces/register';

export async function setup() {
	envRun(new URL('../../../src/.env', import.meta.url));

	setRepository('https://github.com/wolstar-project/starly');
	setInvite('12345678906342567', '0');
	initializeSentry();

	await import('#api/routes/_load');
}
