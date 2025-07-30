import { Events } from '#lib/types';

import { cast, isObject } from '@sapphire/utilities';
import { checkSignature, TwitchEventSubTypes, type TwitchEventSubVerificationMessage } from '@skyra/twitch-helpers';
import { container } from '@sapphire/pieces';

container.server.route({
	url: '/twitch/event_sub_verify',
	method: 'POST',
	handler: async (request, reply) => {
		let lastNotificationId: string | null = null;

		// Grab the headers that we need to use for verification
		const twitchEventSubMessageSignature = cast<string>(request.headers['twitch-eventsub-message-signature']);
		const twitchEventSubMessageId = cast<string>(request.headers['twitch-eventsub-message-id']);
		const twitchEventSubMessageTimestamp = cast<string>(request.headers['twitch-eventsub-message-timestamp']);

		// If this notification is the same as before, then send ok back
		if (lastNotificationId && lastNotificationId === twitchEventSubMessageId) return reply.code(200).send('OK');

		// If there is no body then tell Twitch they are sending malformed data
		if (!isObject(request.body)) return reply.code(400).send('Malformed data received');

		// If any of the headers is missing tell Twitch they are sending invalid data
		if (!twitchEventSubMessageSignature || !twitchEventSubMessageId || !twitchEventSubMessageTimestamp) {
			return reply.code(400).send('Missing required Twitch Eventsub headers');
		}

		// Construct the verification signature
		const twitchEventSubMessage = twitchEventSubMessageId + twitchEventSubMessageTimestamp + JSON.stringify(request.body);

		// Split the algorithm from the signature
		const [algorithm, signature] = twitchEventSubMessageSignature.toString().split('=', 2);

		// Verify the signature
		if (!checkSignature(algorithm, signature, twitchEventSubMessage)) {
			return reply.code(403).send('Invalid Hub signature');
		}

		// Destructure the properties that we need from the body
		const {
			challenge,
			subscription: { type },
			event
		} = request.body as TwitchEventSubVerificationMessage;

		// Tell the Twitch API this response was OK, then continue processing the request
		await reply.code(200).send(challenge);

		// If there is an event then this is an online or offline notification
		// If there is no event this is an endpoint verification request
		if (event) {
			const { client } = container;
			if (type === TwitchEventSubTypes.StreamOnline) {
				client.emit(Events.TwitchStreamHookedAnalytics, TwitchStreamStatus.Online);
				client.emit(Events.TwitchStreamOnline, event);
			} else {
				client.emit(Events.TwitchStreamHookedAnalytics, TwitchStreamStatus.Offline);
				client.emit(Events.TwitchStreamOffline, event);
			}
		}

		// Store the last notification id
		lastNotificationId = twitchEventSubMessageId;

		// Ensure a response is always sent
		return reply.code(200).send('OK');
	}
});
