import { container } from "@wolfstar/http-framework";
import { Logger } from "@wolfstar/logger";

container.logger = new Logger();

declare module "@sapphire/pieces" {
	interface Container {
		logger: Logger;
	}
}
