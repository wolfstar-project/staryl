import { ok } from "@sapphire/result";
import { MessageFlags } from "discord-api-types/v10";
import { expect, it, vi } from "vitest";
import { UserCommand } from "../../src/commands/subscriptions/social/show.ts";
const subscriptions = vi.hoisted(() => vi.fn());
vi.mock("#social/subscriptions", () => ({
	getGuildSocialSubscriptions: subscriptions,
}));
vi.mock("#social/registry", () => ({
	getSocialProvider: () => ({
		getAuthRequirements: () => ({ satisfied: false }),
	}),
}));
vi.mock("@wolfstar/plugin-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("@wolfstar/plugin-i18next")>()),
	getSupportedLanguageT: async (_interaction: unknown, key: string) =>
		key.endsWith("showEmbedTitle")
			? "Subscriptions"
			: key.includes("provider")
				? "Instagram (owner connected)"
				: key.includes("health.")
					? "Unavailable: provider credentials or app approval missing"
					: key.includes("deliveryErrors.")
						? "Missing permissions: View Channel, Send Messages and Embed Links"
						: "",
}));
it("splits a full unavailable guild list into private messages within Discord's combined embed limit", async () => {
	subscriptions.mockResolvedValue(
		ok(
			Array.from({ length: 25 }, (_, index) => ({
				channelId: BigInt(800000000000000000n + BigInt(index)),
				deliveryError: "MissingPermissions",
				source: {
					provider: "Instagram",
					displayName: `Creator ${index} `.padEnd(64, "a"),
					lastFailure: null,
					failureCount: 0,
				},
			})),
		),
	);
	const messages: {
		embeds: { description: string; title?: string }[];
		flags?: number;
	}[] = [];
	const update = vi.fn(async (message) => {
		messages.push(message);
		return ok({});
	});
	const followup = vi.fn(async (message) => {
		messages.push(message);
		return ok({});
	});
	const interaction = {
		guildId: "1",
		data: { options: [{ type: 2, name: "instagram" }] },
		defer: vi.fn().mockResolvedValue({ update }),
		followup,
	};
	await UserCommand.prototype.chatInputRun(interaction as never);
	expect(messages.length).toBeGreaterThan(1);
	for (const message of messages) {
		expect(
			message.embeds.reduce(
				(sum, embed) =>
					sum + embed.description.length + (embed.title?.length ?? 0),
				0,
			),
		).toBeLessThanOrEqual(6000);
		if (message !== messages[0])
			expect(message.flags).toBe(MessageFlags.Ephemeral);
	}
	const text = messages
		.flatMap((message) => message.embeds.map((embed) => embed.description))
		.join("\n");
	expect(text.match(/\(Instagram \(owner connected\)\)/g)).toHaveLength(25);
	expect(text).toContain("Creator 24");
});
