import { err, ok } from "@sapphire/result";
import { expect, it, vi } from "vitest";
import { UserCommand } from "../../src/commands/subscriptions/social/connect.ts";
const begin = vi.hoisted(() => vi.fn());
vi.mock("#social/connectedAccounts", () => ({ beginSocialConnection: begin }));
vi.mock("@wolfstar/plugin-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("@wolfstar/plugin-i18next")>()),
	getSupportedLanguageT: async (
		_interaction: unknown,
		key: string,
		options?: { url?: string },
	) => (options?.url ? `${key}: ${options.url}` : key),
}));
it.each(["success", "Denied", "NotConfigured"])(
	"answers with the correct OAuth result: %s",
	async (outcome) => {
		const url = "https://www.instagram.com/oauth/authorize?state=private";
		begin.mockResolvedValue(outcome === "success" ? ok(url) : err(outcome));
		const update = vi.fn();
		const interaction = {
			guildId: "1",
			data: { options: [{ type: 2, name: "instagram" }] },
			user: { id: "manager" },
			defer: vi.fn().mockResolvedValue({ update }),
		};
		await UserCommand.prototype.chatInputRun(interaction as never, {
			channel: { id: "2" } as never,
		});
		expect(update).toHaveBeenCalledWith({
			content:
				outcome === "success"
					? `commands/social:connectLink: ${url}`
					: outcome === "Denied"
						? "commands/social:connectDenied"
						: "commands/social:connectFailed",
		});
	},
);
