/* eslint-disable antfu/no-top-level-await */
import { setup } from "#lib/setup/all";
import { envParseInteger, envParseString } from "@skyra/env-utilities";
import { Client, container } from "@skyra/http-framework";
import { init, load } from "@skyra/http-framework-i18n";
import { registerCommands } from "@skyra/shared-http-pieces";
import { createBanner } from "@skyra/start-banner";
import { vice } from "gradient-string";

setup();

await load(new URL("../src/locales", import.meta.url));
await init({
  fallbackLng: "en-US",
  returnNull: false,
  returnEmptyString: false,
  returnObjects: true,
});

const client = new Client();
await client.load();

void registerCommands();

const address = envParseString("HTTP_ADDRESS", "0.0.0.0");
const port = envParseInteger("HTTP_PORT", 3000);
await client.listen({ address, port });

console.log(
  vice.multiline(
    createBanner({
      logo: [
        String.raw`              █████              `,
        String.raw`             ███████             `,
        String.raw`            ████ ████            `,
        String.raw`           ████   ████           `,
        String.raw` █████████████     █████████████ `,
        String.raw` ████████████       ████████████ `,
        String.raw` █████                     █████ `,
        String.raw`  █████                   █████  `,
        String.raw`    █████               █████    `,
        String.raw`     █████             █████     `,
        String.raw`       ███             ███       `,
        String.raw`       ███             ███       `,
        String.raw`       ██     █████     ██       `,
        String.raw`      ███  ██████████   ███      `,
        String.raw`      ██████████ ███████ ██      `,
        String.raw`      ███████      ████████      `,
        "",
      ],
      name: [
        String.raw`  .d8888. d888888b  .d8b.  d8888b.   db    db  db  	   `,
        String.raw`  88'  YP '~~88~~' d8' '8b 88  '8D' '8b    d8' 88	   `,
        String.raw`  '8bo.      88    88ooo88 88oobY'   '8bd8'    88	   `,
        String.raw`    'Y8b.    88    88~~~88 88'8b       88      88       `,
        String.raw`  db   8D    88    88   88 88 '88.     88      88booo.  `,
        String.raw`  'Y8888P'   YP    YP   YP 88   YD 	  YP      Y88888P	`,
      ],
      extra: [
        "",
        `Loaded: ${container.stores.get("commands").size} commands`,
        `      : ${container.stores.get("interaction-handlers").size} interaction handlers`,
        `Listening: ${address}:${port}`,
      ],
    }),
  ),
);
