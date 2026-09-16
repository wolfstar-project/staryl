import type { GuildSubscriptionWithTwitch } from "#utils/twitchSubscriptions";
import type { MessageActionRowComponentBuilder } from "@discordjs/builders";
import type { ModalResponseData } from "@wolfstar/http-framework";
import type { TFunction } from "i18next";
import { TwitchSubscriptionType } from "#generated/prisma";
import {
	getSubscriptionStatus,
	MaximumMessageLength,
} from "#utils/twitchSubscriptions";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ContainerBuilder,
	ModalBuilder,
	StringSelectMenuBuilder,
} from "@discordjs/builders";
import { channelMention } from "@discordjs/formatters";
import { cast } from "@sapphire/utilities";
import {
	ButtonStyle,
	ChannelType,
	InteractionResponseType,
	MessageFlags,
	TextInputStyle,
} from "discord-api-types/v10";

export const SetupInteractionHandlerName = "setup";

export type SetupPage = "overview" | "add" | "manage" | "test";

export interface SetupMenuState {
	page: SetupPage;
	subscriptionCount: number;
	userId: string;
	/** Pre-rendered banner text interpolated into the page body; empty when there is nothing to show. */
	notice?: string;
	/** Whether the Manage page is showing the second step of the "reset all" confirmation. */
	confirmingReset?: boolean;
}

export interface SetupMenuPayload {
	components: ReturnType<ContainerBuilder["toJSON"]>[];
	flags: MessageFlags.IsComponentsV2;
}

/**
 * The subscription data a menu page needs to render its options. Defaults to empty so callers on
 * pages that don't need subscription data (Overview, Add) can call {@link buildSetupMenu} with just
 * a state and a `t` function.
 */
export interface SetupMenuContext {
	subscriptions: GuildSubscriptionWithTwitch[];
	streamerNames: ReadonlyMap<string, string>;
	statuses: { live: string; offline: string };
}

const EmptySetupMenuContext: SetupMenuContext = {
	subscriptions: [],
	streamerNames: new Map(),
	statuses: { live: "", offline: "" },
};

/**
 * The JSON shape produced by an {@link ActionRowBuilder} holding message (not modal) components,
 * i.e. what {@link ContainerBuilder.addActionRowComponents} accepts back.
 */
type SetupMenuActionRow = ReturnType<
	ActionRowBuilder<MessageActionRowComponentBuilder>["toJSON"]
>;

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

/**
 * Builds the composite value a Manage/Test select option encodes for one subscription.
 *
 * Discord select values are plain strings, so the channel and Twitch subscription ids are packed
 * into one string; {@link parseSubscriptionKey} is the inverse used to map a chosen value back to
 * the {@link GuildSubscriptionWithTwitch} it came from.
 */
export function buildSubscriptionKey(
	channelId: bigint,
	subscriptionId: bigint,
): string {
	return `${channelId}:${subscriptionId}`;
}

export function parseSubscriptionKey(
	key: string,
): { channelId: bigint; subscriptionId: bigint } | null {
	const parts = key.split(":");
	if (parts.length !== 2) return null;

	const [channelPart, subscriptionPart] = parts;
	if (!/^\d+$/.test(channelPart!) || !/^\d+$/.test(subscriptionPart!)) {
		return null;
	}

	return {
		channelId: BigInt(channelPart!),
		subscriptionId: BigInt(subscriptionPart!),
	};
}

/**
 * Builds the "Add a notification" modal.
 *
 * Every field is a real components-in-modals control (channel/type selects, not text inputs the
 * user has to type correctly) since `@discordjs/builders`' `LabelBuilder` accepts select menu
 * components for modal use (`setChannelSelectMenuComponent`/`setStringSelectMenuComponent`, with
 * `setRequired` on the select itself) — see `node_modules/@discordjs/builders/dist/index.d.ts`.
 */
export function buildAddModal(userId: string, t: TFunction): ModalResponseData {
	const modal = new ModalBuilder()
		.setCustomId(buildSetupCustomId(userId, "add:submit"))
		.setTitle(cast<string>(t("commands/setup:modal.title")))
		.addLabelComponents(
			(label) =>
				label
					.setLabel(cast<string>(t("commands/setup:modal.streamer.label")))
					.setTextInputComponent((input) =>
						input
							.setCustomId("streamer")
							.setStyle(TextInputStyle.Short)
							.setRequired(true)
							.setPlaceholder(
								cast<string>(t("commands/setup:modal.streamer.placeholder")),
							),
					),
			(label) =>
				label
					.setLabel(cast<string>(t("commands/setup:modal.channel.label")))
					.setChannelSelectMenuComponent((select) =>
						select
							.setCustomId("channel")
							.addChannelTypes(
								ChannelType.GuildText,
								ChannelType.GuildAnnouncement,
							)
							.setRequired(true),
					),
			(label) =>
				label
					.setLabel(cast<string>(t("commands/setup:modal.type.label")))
					.setStringSelectMenuComponent((select) =>
						select
							.setCustomId("type")
							.setRequired(true)
							.addOptions(
								{
									label: cast<string>(t("commands/setup:modal.type.online")),
									value: TwitchSubscriptionType.StreamOnline,
								},
								{
									label: cast<string>(t("commands/setup:modal.type.offline")),
									value: TwitchSubscriptionType.StreamOffline,
								},
							),
					),
			(label) =>
				label
					.setLabel(cast<string>(t("commands/setup:modal.message.label")))
					.setTextInputComponent((input) =>
						input
							.setCustomId("message")
							.setStyle(TextInputStyle.Paragraph)
							.setRequired(false)
							.setMaxLength(MaximumMessageLength)
							.setPlaceholder(
								cast<string>(t("commands/setup:modal.message.placeholder")),
							),
					),
		);

	return {
		type: InteractionResponseType.Modal,
		data: modal.toJSON(),
	};
}

function buildSubscriptionOptions(
	subscriptions: GuildSubscriptionWithTwitch[],
	streamerNames: ReadonlyMap<string, string>,
	statuses: { live: string; offline: string },
) {
	return subscriptions.map((subscription) => {
		const { twitchSubscription } = subscription;
		const value = buildSubscriptionKey(
			subscription.channelId,
			twitchSubscription.id,
		);

		return {
			label:
				streamerNames.get(twitchSubscription.streamerId) ??
				twitchSubscription.streamerId,
			description: `${channelMention(subscription.channelId.toString())} • ${getSubscriptionStatus(twitchSubscription.subscriptionType, statuses)}`,
			value,
		};
	});
}

/**
 * Builds the Manage page's extra rows: a multi-select of the guild's subscriptions (selecting one or
 * more removes them immediately, mirroring the Test page's select-to-act pattern — a separate
 * "remove selected" button can't carry the selection across interactions, since Discord button
 * clicks don't resend the select's current values and the composite keys wouldn't fit a 100-char
 * custom_id for more than a couple of entries) plus a "Reset all" button that requires a second click
 * ("Confirm reset all") to actually run, since it has no per-item data to encode and is destructive
 * enough to warrant the extra step.
 *
 * Returns no select when the guild has no subscriptions; the empty state is conveyed through the page
 * text instead of a disabled control. The reset button(s) still render so an empty guild's Manage page
 * isn't completely inert (harmless: {@link resetGuildSubscriptions} on an empty list is a no-op).
 */
export function buildManagePage(
	state: SetupMenuState,
	subscriptions: GuildSubscriptionWithTwitch[],
	streamerNames: ReadonlyMap<string, string>,
	statuses: { live: string; offline: string },
	t: TFunction,
): SetupMenuActionRow[] {
	const rows: SetupMenuActionRow[] = [];

	if (subscriptions.length > 0) {
		rows.push(
			new ActionRowBuilder<MessageActionRowComponentBuilder>()
				.setComponents(
					new StringSelectMenuBuilder()
						.setCustomId(buildSetupCustomId(state.userId, "manage:select"))
						.setPlaceholder(
							cast<string>(t("commands/setup:manage.selectPlaceholder")),
						)
						.setMinValues(1)
						.setMaxValues(subscriptions.length)
						.addOptions(
							...buildSubscriptionOptions(
								subscriptions,
								streamerNames,
								statuses,
							),
						),
				)
				.toJSON(),
		);
	}

	const buttonsRow = new ActionRowBuilder<MessageActionRowComponentBuilder>();
	if (state.confirmingReset) {
		buttonsRow.addComponents(
			new ButtonBuilder()
				.setCustomId(buildSetupCustomId(state.userId, "manage:reset:confirm"))
				.setLabel(cast<string>(t("commands/setup:manage.resetConfirmButton")))
				.setStyle(ButtonStyle.Danger),
		);
	} else {
		buttonsRow.addComponents(
			new ButtonBuilder()
				.setCustomId(buildSetupCustomId(state.userId, "manage:reset:open"))
				.setLabel(cast<string>(t("commands/setup:manage.resetButton")))
				.setStyle(ButtonStyle.Danger)
				.setDisabled(subscriptions.length === 0),
		);
	}
	rows.push(buttonsRow.toJSON());

	return rows;
}

/**
 * Builds the Test page's extra row: a single-select of the guild's subscriptions. Selecting one acts
 * immediately (mirrors the existing `/subscriptions twitch test` subcommand), so there are no buttons.
 */
export function buildTestPage(
	state: SetupMenuState,
	subscriptions: GuildSubscriptionWithTwitch[],
	streamerNames: ReadonlyMap<string, string>,
	statuses: { live: string; offline: string },
	t: TFunction,
): SetupMenuActionRow[] {
	if (subscriptions.length === 0) return [];

	const selectRow =
		new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(
			new StringSelectMenuBuilder()
				.setCustomId(buildSetupCustomId(state.userId, "test:select"))
				.setPlaceholder(
					cast<string>(t("commands/setup:test.selectPlaceholder")),
				)
				.setMinValues(1)
				.setMaxValues(1)
				.addOptions(
					...buildSubscriptionOptions(subscriptions, streamerNames, statuses),
				),
		);

	return [selectRow.toJSON()];
}

function buildPageRows(
	state: SetupMenuState,
	context: SetupMenuContext,
	t: TFunction,
): SetupMenuActionRow[] {
	switch (state.page) {
		case "manage":
			return buildManagePage(
				state,
				context.subscriptions,
				context.streamerNames,
				context.statuses,
				t,
			);
		case "test":
			return buildTestPage(
				state,
				context.subscriptions,
				context.streamerNames,
				context.statuses,
				t,
			);
		case "add":
			return [
				new ActionRowBuilder<MessageActionRowComponentBuilder>()
					.addComponents(
						new ButtonBuilder()
							.setCustomId(buildSetupCustomId(state.userId, "add:open"))
							.setLabel(
								cast<string>(t("commands/setup:menu.options.add.label")),
							)
							.setStyle(ButtonStyle.Primary),
					)
					.toJSON(),
			];
		default:
			return [];
	}
}

export function buildSetupMenu(
	state: SetupMenuState,
	t: TFunction,
	context: SetupMenuContext = EmptySetupMenuContext,
): SetupMenuPayload {
	const container = new ContainerBuilder()
		.setAccentColor(9_520_895)
		.addTextDisplayComponents((textDisplay) =>
			textDisplay.setContent(renderPage(state, t)),
		)
		.addSeparatorComponents((separator) => separator);

	const pageRows = buildPageRows(state, context, t);
	if (pageRows.length > 0) {
		container.addActionRowComponents(...pageRows);
	}

	container
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
	{ page, subscriptionCount, notice }: SetupMenuState,
	t: TFunction,
): string {
	return cast<string>(
		t(`commands/setup:pages.${page}`, {
			count: subscriptionCount,
			notice: notice ?? "",
		}),
	);
}
