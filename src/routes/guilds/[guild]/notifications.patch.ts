import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { authorizeGuildRequest } from "#utils/guildApi/auth";
import { parseSwitchBody } from "#utils/guildApi/body";
import { setGuildNotificationsEnabled } from "#utils/guildApi/state";
import { Result } from "@sapphire/result";
import { Route } from "@wolfstar/plugin-api";

/**
 * `PATCH /guilds/:guild/notifications`: turns the guild's notifications on or off. Off keeps every
 * subscription, the poller and the Twitch listeners only stop posting for the guild.
 */
export class UserRoute extends Route {
	public async run(request: ApiRequest, response: ApiResponse) {
		const guild = authorizeGuildRequest(request, response);
		if (guild === null) return;

		const body = parseSwitchBody(
			await Result.fromAsync(() => request.readBodyJson()),
		);
		if (body === null) {
			response.error(400, "invalid-body");
			return;
		}

		const saved = await Result.fromAsync(() =>
			setGuildNotificationsEnabled(guild.guildId, body.enabled),
		);
		if (saved.isErr()) {
			this.container.logger.error(
				`[guild-api] Could not switch the notifications of guild ${guild.guildId}`,
				saved.unwrapErr(),
			);
			response.error(500, "database");
			return;
		}

		this.container.logger.info(
			`[guild-api] Notifications of guild ${guild.guildId} turned ${body.enabled ? "on" : "off"} by ${guild.actor ?? "an unnamed member"}`,
		);
		response.json({ enabled: body.enabled, previous: saved.unwrap() });
	}
}
