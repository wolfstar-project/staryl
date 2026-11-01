import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import {
	extractChannelIds,
	isValidHubSignature,
	isWebSubConfigured,
	readPushBody,
	wakeChannel,
} from "#social/websub";
import { Route } from "@wolfstar/plugin-api";

export class UserRoute extends Route {
	public async run(request: ApiRequest, response: ApiResponse) {
		const body = await readPushBody(request as AsyncIterable<Buffer>);

		// WebSub asks for a success even on a bad signature: a refusal would only make the hub retry,
		// and tell whoever forged it what was wrong.
		response.text("OK");

		if (body === null || !isWebSubConfigured()) return;

		const signature = request.headers["x-hub-signature"];
		if (
			!isValidHubSignature(process.env.YOUTUBE_WEBSUB_SECRET!, signature, body)
		) {
			this.container.logger.warn("[youtube] Ignored a badly signed push");
			return;
		}

		await Promise.all(extractChannelIds(body).map(wakeChannel));
	}
}
