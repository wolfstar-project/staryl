import type { IncomingMessage, ServerResponse } from "node:http";
import { Events } from "#types";
import { ApplyOptions } from "@wolfstar/decorators";
import { Listener } from "@wolfstar/http-framework";

/**
 * Logs each request of the interactions server once it is answered, with the body of a POST.
 *
 * @remarks Only in development: the body of an interaction holds what members typed.
 */
@ApplyOptions<Listener.Options>({
	emitter: "client",
	event: Events.ServerRequest,
})
export class UserListener extends Listener {
	public run(request: IncomingMessage, response: ServerResponse) {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		response.on("finish", () => {
			const line = `${request.method} ${request.url} → ${response.statusCode}`;
			// The body is only there when the framework read it, which it does after checking the signature headers:
			this.container.logger.info(
				request.method === "POST" && chunks.length > 0
					? `${line} | body: ${Buffer.concat(chunks).toString("utf8")}`
					: line,
			);
		});
	}

	public override onLoad() {
		this.enabled = process.env.NODE_ENV === "development";
		return super.onLoad();
	}
}
