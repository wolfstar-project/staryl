import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import type { TwitchEventSubVerificationMessage } from "@wolfstar/twitch-helpers";
import { Events, TwitchStreamStatus } from "#types";
import { container } from "@sapphire/pieces";
import { cast, isObject } from "@sapphire/utilities";
import { Route } from "@wolfstar/plugin-api";
import { checkSignature, TwitchEventSubTypes } from "@wolfstar/twitch-helpers";

let lastNotificationId: string | null = null;

export class TwitchEventSubVerifyRoute extends Route {
	public async run(request: ApiRequest, response: ApiResponse) {
		// Grab the headers that we need to use for verification
		const twitchEventSubMessageSignature = cast<string>(
			request.headers["twitch-eventsub-message-signature"],
		);
		const twitchEventSubMessageId = cast<string>(
			request.headers["twitch-eventsub-message-id"],
		);
		const twitchEventSubMessageTimestamp = cast<string>(
			request.headers["twitch-eventsub-message-timestamp"],
		);

		// If this notification is the same as before, then send ok back
		if (lastNotificationId && lastNotificationId === twitchEventSubMessageId) {
			response.text("OK");
			return;
		}

		// If any of the headers is missing tell Twitch they are sending invalid data
		if (
			!twitchEventSubMessageSignature ||
			!twitchEventSubMessageId ||
			!twitchEventSubMessageTimestamp
		) {
			response.badRequest("Missing required Twitch Eventsub headers");
			return;
		}

		const bodyText = await request.readBodyText();
		let body: unknown;
		try {
			body = JSON.parse(bodyText);
		} catch {
			response.badRequest("Malformed data received");
			return;
		}

		// If there is no body then tell Twitch they are sending malformed data
		if (!isObject(body)) {
			response.badRequest("Malformed data received");
			return;
		}

		// Construct the verification signature
		const twitchEventSubMessage =
			twitchEventSubMessageId + twitchEventSubMessageTimestamp + bodyText;

		// Split the algorithm from the signature
		const [algorithm, signature] = twitchEventSubMessageSignature.split("=", 2);

		// Verify the signature
		if (!checkSignature(algorithm, signature, twitchEventSubMessage)) {
			response.error(403, "Invalid Hub signature");
			return;
		}

		// If the EventSub envelope is missing the subscription type then tell
		// Twitch they are sending malformed data
		const { subscription } = body as Partial<TwitchEventSubVerificationMessage>;
		if (!isObject(subscription) || typeof subscription.type !== "string") {
			response.badRequest("Malformed data received");
			return;
		}

		// Destructure the properties that we need from the body
		const { challenge, event } = body as TwitchEventSubVerificationMessage;
		const { type } = subscription;

		// Tell the Twitch API this response was OK
		response.text(challenge);

		// If there is an event then this is an online or offline notification
		// If there is no event this is an endpoint verification request
		if (event) {
			const { client } = container;
			if (type === TwitchEventSubTypes.StreamOnline) {
				client.emit(
					Events.TwitchStreamHookedAnalytics,
					TwitchStreamStatus.Online,
				);
				client.emit(Events.TwitchStreamOnline, event);
			} else {
				client.emit(
					Events.TwitchStreamHookedAnalytics,
					TwitchStreamStatus.Offline,
				);
				client.emit(Events.TwitchStreamOffline, event);
			}
		}

		// Store the last notification id
		lastNotificationId = twitchEventSubMessageId;
	}
}
