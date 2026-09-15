import type { TFunction } from "i18next";
import {
	ButtonBuilder,
	ContainerBuilder,
	StringSelectMenuBuilder,
} from "@discordjs/builders";
import { cast } from "@sapphire/utilities";
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

const SetupPages: ReadonlySet<SetupPage> = new Set([
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

export function buildSetupMenu(
	state: SetupMenuState,
	t: TFunction,
): SetupMenuPayload {
	const container = new ContainerBuilder()
		.setAccentColor(9_520_895)
		.addTextDisplayComponents((textDisplay) =>
			textDisplay.setContent(renderPage(state, t)),
		)
		.addSeparatorComponents((separator) => separator)
		.addActionRowComponents((row) =>
			row.setComponents(
				new StringSelectMenuBuilder()
					.setCustomId(buildSetupCustomId(state.userId, "navigate"))
					.setPlaceholder(cast<string>(t("commands/setup:menu.placeholder")))
					.addOptions(
						{
							label: cast<string>(
								t("commands/setup:menu.options.overview.label"),
							),
							value: "overview",
							description: cast<string>(
								t("commands/setup:menu.options.overview.description"),
							),
							emoji: { name: "🏠" },
							default: state.page === "overview",
						},
						{
							label: cast<string>(t("commands/setup:menu.options.add.label")),
							value: "add",
							description: cast<string>(
								t("commands/setup:menu.options.add.description"),
							),
							emoji: { name: "➕" },
							default: state.page === "add",
						},
						{
							label: cast<string>(
								t("commands/setup:menu.options.manage.label"),
							),
							value: "manage",
							description: cast<string>(
								t("commands/setup:menu.options.manage.description"),
							),
							emoji: { name: "⚙️" },
							default: state.page === "manage",
						},
						{
							label: cast<string>(t("commands/setup:menu.options.test.label")),
							value: "test",
							description: cast<string>(
								t("commands/setup:menu.options.test.description"),
							),
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
					.setLabel(cast<string>(t("commands/setup:menu.close")))
					.setEmoji({ name: "⏹️" })
					.setStyle(ButtonStyle.Danger),
			),
		);

	return {
		components: [container.toJSON()],
		flags: MessageFlags.IsComponentsV2,
	};
}

export function buildClosedSetupMenu(t: TFunction): SetupMenuPayload {
	const container = new ContainerBuilder()
		.setAccentColor(5_793_266)
		.addTextDisplayComponents((textDisplay) =>
			textDisplay.setContent(cast<string>(t("commands/setup:closed"))),
		);

	return {
		components: [container.toJSON()],
		flags: MessageFlags.IsComponentsV2,
	};
}

function renderPage(
	{ page, subscriptionCount }: SetupMenuState,
	t: TFunction,
): string {
	return cast<string>(
		t(`commands/setup:pages.${page}`, { count: subscriptionCount }),
	);
}
