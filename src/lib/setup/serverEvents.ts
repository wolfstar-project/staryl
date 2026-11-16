import { Events } from "#types";
import { definePlugin } from "@wolfstar/http-framework";

/**
 * Forwards each request of the interactions server to the client as {@link Events.ServerRequest}.
 *
 * The client creates its server inside `listen()`, after the listener pieces are loaded, so a listener
 * cannot name the server as its emitter. Development only, like the listener that logs the requests.
 */
export const serverEventsPlugin = definePlugin({
	name: "Staryl-ServerEvents",
	apply: "development",
	postListen(client) {
		client.server.on("request", (request, response) =>
			client.emit(Events.ServerRequest, request, response),
		);
	},
});
