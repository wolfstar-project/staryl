import { container } from "@wolfstar/http-framework";
import { init, load } from "@wolfstar/http-framework-i18n";
import { httpFrameworkMatchers } from "@wolfstar/http-framework-test-utils/vitest";
import { Logger } from "@wolfstar/logger";
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

await load(new URL("../src/locales", import.meta.url));
await init({
	fallbackLng: "en-US",
	returnNull: false,
	returnObjects: true,
	returnEmptyString: false,
});
