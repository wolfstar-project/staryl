import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { finishSocialConnection } from "#social/connectedAccounts";
import { createTikTokApi } from "#social/providers/tiktok";
import { Result } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { Route } from "@wolfstar/plugin-api";
export class UserRoute extends Route {
	public async run(request: ApiRequest, response: ApiResponse) {
		const { state, code } = request.query;
		const result = await Result.fromAsync(() =>
			typeof state === "string" && typeof code === "string"
				? finishSocialConnection(createTikTokApi(), state, code)
				: Promise.resolve(false),
		);
		if (result.isErr()) container.logger.warn("[tiktok] OAuth callback failed");
		response
			.status(result.unwrapOr(false) ? 200 : 400)
			.text(
				result.unwrapOr(false)
					? "Connected. Return to Discord and use /subscriptions social show."
					: "Connection failed or expired. Start /subscriptions social connect again.",
			);
	}
}
