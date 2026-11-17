import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { authorizeGuildRequest } from "#utils/guildApi/auth";
import { readGuildApiState } from "#utils/guildApi/state";
import { Result } from "@sapphire/result";
import { Route } from "@wolfstar/plugin-api";

/** `GET /guilds/:guild/notifications`: the switch, the providers and every subscription of a guild. */
export class UserRoute extends Route {
	public async run(request: ApiRequest, response: ApiResponse) {
		const guild = authorizeGuildRequest(request, response);
		if (guild === null) return;

		const state = await Result.fromAsync(() =>
			readGuildApiState(guild.guildId),
		);
		if (state.isErr()) {
			this.container.logger.error(
				`[guild-api] Could not read the notifications of guild ${guild.guildId}`,
				state.unwrapErr(),
			);
			response.error(500, "database");
			return;
		}

		response.json(state.unwrap());
	}
}
