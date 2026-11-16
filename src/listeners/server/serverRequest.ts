import type { IncomingMessage, ServerResponse } from "node:http";
import { StarylEvents } from "#types";
import { ApplyOptions } from "@wolfstar/decorators";
import { Listener } from "@wolfstar/http-framework";

/** Logs each interaction request once answered, with the body of a POST. Development only. */
@ApplyOptions<Listener.Options>({
	emitter: "client",
	event: StarylEvents.ServerRequest,
})
export class UserListener extends Listener {
	public run(request: IncomingMessage, response: ServerResponse) {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		response.on("finish", () => {
			const base = `${request.method} ${request.url} → ${response.statusCode}`;
			this.container.logger.info(
				request.method === "POST" && chunks.length > 0
					? `${base} | body: ${Buffer.concat(chunks).toString("utf8")}`
					: base,
			);
		});
	}
}
