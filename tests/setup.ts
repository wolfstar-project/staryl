import { init, load } from "@wolfstar/http-framework-i18n";
import { httpFrameworkMatchers } from "@wolfstar/http-framework-test-utils/vitest";
import { expect } from "vitest";

process.env["DISCORD_PUBLIC_KEY"] ??= "test-discord-public-key";
process.env["DISCORD_TOKEN"] ??= "test.discord.token";

expect.extend(httpFrameworkMatchers);

await load(new URL("../src/locales", import.meta.url));
await init({
	fallbackLng: "en-US",
	returnNull: false,
	returnObjects: true,
	returnEmptyString: false,
});
