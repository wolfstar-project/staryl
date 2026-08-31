import { fileURLToPath } from "node:url";
import { container } from "@wolfstar/http-framework";
import { httpFrameworkMatchers } from "@wolfstar/http-framework-test-utils/vitest";
import { Logger } from "@wolfstar/logger";
import { InternationalizationHandler } from "@wolfstar/plugin-i18next";
import { expect } from "vitest";

process.env["DISCORD_PUBLIC_KEY"] ??= "test-discord-public-key";
process.env["DISCORD_TOKEN"] ??= "test.discord.token";

// `#lib/setup/logger` is only imported by the entrypoint, so pieces that log during a test would
// otherwise blow up on an undefined `container.logger`. The level is set above `Fatal` so the
// expected-failure tests do not spam the reporter.
container.logger = new Logger({
	level: (Logger.Level.Fatal + 1) as Logger.Level,
});

expect.extend(httpFrameworkMatchers);

// No `Client` is created in the test suite, so `@wolfstar/plugin-i18next/register` never runs its
// `preGenericsInitialization`/`preLoad` hooks; the handler is built and initialized by hand with
// the same options `src/main.ts` passes to the client.
container.i18n = new InternationalizationHandler({
	defaultLanguageDirectory: fileURLToPath(
		new URL("../src/locales", import.meta.url),
	),
	defaultName: "en-US",
	defaultNS: "globals",
	defaultMissingKey: "globals:default",
	i18next: {
		returnNull: false,
		returnObjects: true,
		returnEmptyString: false,
	},
});
await container.i18n.init();
