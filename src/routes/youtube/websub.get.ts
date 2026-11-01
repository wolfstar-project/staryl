import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import {
	isFollowedChannel,
	isValidCallbackToken,
	isWebSubConfigured,
	parseTopicChannelId,
} from "#social/websub";
import { Route } from "@wolfstar/plugin-api";

export class UserRoute extends Route {
	/**
	 * The hub calling back to confirm a subscription. It only succeeds for a channel a server here
	 * follows, on a callback we built, so nobody else can subscribe this endpoint to anything.
	 */
	public async run(request: ApiRequest, response: ApiResponse) {
		const {
			"hub.mode": mode,
			"hub.topic": topic,
			"hub.challenge": challenge,
			token,
		} = request.query;

		const channelId = parseTopicChannelId(topic);
		const isConfirmable =
			isWebSubConfigured() &&
			mode === "subscribe" &&
			typeof challenge === "string" &&
			channelId !== null &&
			isValidCallbackToken(
				process.env.YOUTUBE_WEBSUB_SECRET!,
				channelId,
				token,
			) &&
			(await isFollowedChannel(channelId));

		if (isConfirmable) {
			response.text(challenge);
			return;
		}

		response.status(404).text("Not Found");
	}
}
