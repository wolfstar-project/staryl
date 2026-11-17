import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { finishSocialConnection } from "#social/connectedAccounts";
import { createInstagramApi } from "#social/providers/instagram";
import { Result } from "@sapphire/result";
import { ApplyOptions } from "@wolfstar/decorators";
import { container } from "@wolfstar/http-framework";
import { Route } from "@wolfstar/plugin-api";
// A piece is stored under its name, which is its file name unless set. Both OAuth callbacks are
// `callback.get.ts`, so each one is named here, or the second loaded unloads the first. A route
// with its own name takes its path and method from these options, not from its file.
@ApplyOptions<Route.Options>({
	name: "instagram-callback",
	route: "/social/instagram/callback",
	methods: ["GET"],
})
export class UserRoute extends Route {
	public async run(request: ApiRequest, response: ApiResponse) {
		const { state, code } = request.query;
		const result = await Result.fromAsync(() =>
			typeof state === "string" && typeof code === "string"
				? finishSocialConnection(createInstagramApi(), state, code)
				: Promise.resolve(false),
		);
		if (result.isErr())
			container.logger.warn("[instagram] OAuth callback failed");
		response
			.status(result.unwrapOr(false) ? 200 : 400)
			.text(
				result.unwrapOr(false)
					? "Connected. Return to Discord and use /subscriptions instagram show."
					: "Connection failed or expired. Start /subscriptions instagram connect again.",
			);
	}
}
