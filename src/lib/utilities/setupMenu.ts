import {
	ButtonBuilder,
	ContainerBuilder,
	StringSelectMenuBuilder,
} from "@discordjs/builders";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";

export const SetupInteractionHandlerName = "setup";

export type SetupPage = "overview" | "add" | "manage" | "test";

export interface SetupMenuState {
	page: SetupPage;
	subscriptionCount: number;
	userId: string;
}

export interface SetupMenuPayload {
	components: ReturnType<ContainerBuilder["toJSON"]>[];
	flags: MessageFlags.IsComponentsV2;
}

const SetupPages: readonly SetupPage[] = new Set([
	"overview",
	"add",
	"manage",
	"test",
]);

export function isSetupPage(value: string): value is SetupPage {
	return SetupPages.has(value as SetupPage);
}

export function buildSetupCustomId(userId: string, action: string): string {
	return `${SetupInteractionHandlerName}.${userId}.${action}`;
}

export function buildSetupMenu(state: SetupMenuState): SetupMenuPayload {
	const container = new ContainerBuilder()
		.setAccentColor(9_520_895)
		.addTextDisplayComponents((textDisplay) =>
			textDisplay.setContent(renderPage(state)),
		)
		.addSeparatorComponents((separator) => separator)
		.addActionRowComponents((row) =>
			row.setComponents(
				new StringSelectMenuBuilder()
					.setCustomId(buildSetupCustomId(state.userId, "navigate"))
					.setPlaceholder("Choose what you want to configure")
					.addOptions(
						{
							label: "Overview",
							value: "overview",
							description: "View the setup status",
							emoji: { name: "🏠" },
							default: state.page === "overview",
						},
						{
							label: "Add a notification",
							value: "add",
							description: "Subscribe to a Twitch streamer",
							emoji: { name: "➕" },
							default: state.page === "add",
						},
						{
							label: "Manage notifications",
							value: "manage",
							description: "Review, remove, or reset subscriptions",
							emoji: { name: "⚙️" },
							default: state.page === "manage",
						},
						{
							label: "Test notifications",
							value: "test",
							description: "Verify the real delivery path",
							emoji: { name: "🧪" },
							default: state.page === "test",
						},
					),
			),
		)
		.addActionRowComponents((row) =>
			row.setComponents(
				new ButtonBuilder()
					.setCustomId(buildSetupCustomId(state.userId, "close"))
					.setLabel("Close setup")
					.setEmoji({ name: "⏹️" })
					.setStyle(ButtonStyle.Danger),
			),
		);

	return {
		components: [container.toJSON()],
		flags: MessageFlags.IsComponentsV2,
	};
}

export function buildClosedSetupMenu(): SetupMenuPayload {
	const container = new ContainerBuilder()
		.setAccentColor(5_793_266)
		.addTextDisplayComponents((textDisplay) =>
			textDisplay.setContent(
				"## Setup closed\nRun `/setup` whenever you need it again.",
			),
		);

	return {
		components: [container.toJSON()],
		flags: MessageFlags.IsComponentsV2,
	};
}

function renderPage({ page, subscriptionCount }: SetupMenuState): string {
	switch (page) {
		case "add":
			return [
				"## Add a Twitch notification",
				"Run `/subscriptions twitch add` and choose:",
				"- the **streamer** to follow;",
				"- the Discord **channel** that receives the notification;",
				"- whether to notify when the stream goes **online** or **offline**;",
				"- an optional custom message (required for offline notifications).",
			].join("\n");
		case "manage":
			return [
				"## Manage Twitch notifications",
				`This server currently has **${subscriptionCount}** configured ${subscriptionCount === 1 ? "notification" : "notifications"}.`,
				"- `/subscriptions twitch show` lists the current configuration.",
				"- `/subscriptions twitch remove` removes one notification.",
				"- `/subscriptions twitch reset` removes all notifications, or only those for one streamer.",
			].join("\n");
		case "test":
			return [
				"## Test a notification",
				"Run `/subscriptions twitch test` after adding a subscription.",
				"Staryl will send a preview through the same delivery path used by real Twitch events, so you can verify the channel and bot permissions.",
			].join("\n");
		case "overview":
			return [
				"## Staryl setup",
				"Configure Twitch notifications for this server from one place.",
				`**Current notifications:** ${subscriptionCount}`,
				"Use the menu below to add, manage, or test a notification.",
			].join("\n");
	}
}
