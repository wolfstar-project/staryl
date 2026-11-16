import type { AddressInfo } from "node:net";
import { createClient, loadAll } from "#lib/Client";
import { initializeApp } from "#lib/setup/all";
import { container } from "@wolfstar/http-framework";
import { createBanner } from "@wolfstar/start-banner";
import { vice } from "gradient-string";

await initializeApp();
createClient();
await loadAll();

printBanner();
container.logger.info("Ready");

function printBanner() {
	// The address the server is bound to, which is what the requests have to reach:
	const { address, port } = container.client.server.address() as AddressInfo;
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
}
