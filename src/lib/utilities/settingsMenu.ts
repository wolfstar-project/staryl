import type { GuildSubscriptionWithTwitch } from "#twitch/subscriptions";
import type { MessageActionRowComponentBuilder } from "@discordjs/builders";
import type { ModalResponseData } from "@wolfstar/http-framework";
import type { AnyNamespace, TFunction } from "@wolfstar/plugin-i18next";
import { TwitchSubscriptionType } from "#generated/prisma";
import { SocialProviders } from "#social/registry";
import {
	getSubscriptionStatus,
	MaximumMessageLength,
} from "#twitch/subscriptions";
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

export const SettingsInteractionHandlerName = "settings";

export const MaximumSelectOptions = 25;

export type SettingsPage = "overview" | "twitch" | "add" | "manage" | "test";

export interface SettingsMenuState {
	page: SettingsPage;
	pageIndex?: number;
	subscriptionCount: number;
	userId: string;
	/** Pre-rendered banner text interpolated into the page body; empty when there is nothing to show. */
	notice?: string;
	/** Whether the Manage page is showing the second step of the "reset all" confirmation. */
	confirmingReset?: boolean;
}

export interface SettingsMenuPayload {
	components: ReturnType<ContainerBuilder["toJSON"]>[];
	flags: MessageFlags.IsComponentsV2;
	allowed_mentions?: { parse: [] };
}

/**
 * The subscription data a menu page needs to render its options. Defaults to empty so callers on
 * pages that don't need subscription data (Overview, Add) can call {@link buildSettingsMenu} with just
 * a state and a `t` function.
 */
export interface SettingsMenuContext {
	subscriptions: GuildSubscriptionWithTwitch[];
	streamerNames: ReadonlyMap<string, string>;
	statuses: { live: string; offline: string };
}

const EmptySettingsMenuContext: SettingsMenuContext = {
	subscriptions: [],
	streamerNames: new Map(),
	statuses: { live: "", offline: "" },
};

/**
 * The JSON shape produced by an {@link ActionRowBuilder} holding message (not modal) components,
 * i.e. what {@link ContainerBuilder.addActionRowComponents} accepts back.
 */
type SettingsMenuActionRow = ReturnType<
	ActionRowBuilder<MessageActionRowComponentBuilder>["toJSON"]
>;

const SettingsPages: ReadonlySet<SettingsPage> = new Set([
	"twitch",
	"overview",
	"add",
	"manage",
	"test",
]);

export function isSettingsPage(value: string): value is SettingsPage {
	return SettingsPages.has(value as SettingsPage);
}

export function buildSettingsCustomId(userId: string, action: string): string {
	return `${SettingsInteractionHandlerName}.${userId}.${action}`;
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
export function buildAddModal(
	userId: string,
	t: TFunction<AnyNamespace>,
): ModalResponseData {
	const modal = new ModalBuilder()
		.setCustomId(buildSettingsCustomId(userId, "add:submit"))
		.setTitle(cast<string>(t("commands/settings:modal.title")))
		.addLabelComponents(
			(label) =>
				label
					.setLabel(cast<string>(t("commands/settings:modal.streamer.label")))
					.setTextInputComponent((input) =>
						input
							.setCustomId("streamer")
							.setStyle(TextInputStyle.Short)
							.setRequired(true)
							.setPlaceholder(
								cast<string>(t("commands/settings:modal.streamer.placeholder")),
							),
					),
			(label) =>
				label
					.setLabel(cast<string>(t("commands/settings:modal.channel.label")))
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
					.setLabel(cast<string>(t("commands/settings:modal.type.label")))
					.setStringSelectMenuComponent((select) =>
						select
							.setCustomId("type")
							.setRequired(true)
							.addOptions(
								{
									label: cast<string>(t("commands/settings:modal.type.online")),
									value: TwitchSubscriptionType.StreamOnline,
								},
								{
									label: cast<string>(
										t("commands/settings:modal.type.offline"),
									),
									value: TwitchSubscriptionType.StreamOffline,
								},
							),
					),
			(label) =>
				label
					.setLabel(cast<string>(t("commands/settings:modal.message.label")))
					.setTextInputComponent((input) =>
						input
							.setCustomId("message")
							.setStyle(TextInputStyle.Paragraph)
							.setRequired(false)
							.setMaxLength(MaximumMessageLength)
							.setPlaceholder(
								cast<string>(t("commands/settings:modal.message.placeholder")),
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
	state: SettingsMenuState,
	subscriptions: GuildSubscriptionWithTwitch[],
	streamerNames: ReadonlyMap<string, string>,
	statuses: { live: string; offline: string },
	t: TFunction<AnyNamespace>,
): SettingsMenuActionRow[] {
	const rows: SettingsMenuActionRow[] = [];

	if (subscriptions.length > 0) {
		const selectable = subscriptions.slice(
			getSettingsPageIndex(state, subscriptions.length) * MaximumSelectOptions,
			(getSettingsPageIndex(state, subscriptions.length) + 1) *
				MaximumSelectOptions,
		);
		rows.push(
			new ActionRowBuilder<MessageActionRowComponentBuilder>()
				.setComponents(
					new StringSelectMenuBuilder()
						.setCustomId(buildSettingsCustomId(state.userId, "manage:select"))
						.setPlaceholder(
							cast<string>(t("commands/settings:manage.selectPlaceholder")),
						)
						.setMinValues(1)
						.setMaxValues(selectable.length)
						.addOptions(
							...buildSubscriptionOptions(selectable, streamerNames, statuses),
						),
				)
				.toJSON(),
		);
	}

	const buttonsRow = new ActionRowBuilder<MessageActionRowComponentBuilder>();
	if (state.confirmingReset) {
		buttonsRow.addComponents(
			new ButtonBuilder()
				.setCustomId(
					buildSettingsCustomId(state.userId, "manage:reset:confirm"),
				)
				.setLabel(
					cast<string>(t("commands/settings:manage.resetConfirmButton")),
				)
				.setStyle(ButtonStyle.Danger),
		);
	} else {
		buttonsRow.addComponents(
			new ButtonBuilder()
				.setCustomId(buildSettingsCustomId(state.userId, "manage:reset:open"))
				.setLabel(cast<string>(t("commands/settings:manage.resetButton")))
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
	state: SettingsMenuState,
	subscriptions: GuildSubscriptionWithTwitch[],
	streamerNames: ReadonlyMap<string, string>,
	statuses: { live: string; offline: string },
	t: TFunction<AnyNamespace>,
): SettingsMenuActionRow[] {
	if (subscriptions.length === 0) return [];

	const selectable = subscriptions.slice(
		getSettingsPageIndex(state, subscriptions.length) * MaximumSelectOptions,
		(getSettingsPageIndex(state, subscriptions.length) + 1) *
			MaximumSelectOptions,
	);
	const selectRow =
		new ActionRowBuilder<MessageActionRowComponentBuilder>().setComponents(
			new StringSelectMenuBuilder()
				.setCustomId(buildSettingsCustomId(state.userId, "test:select"))
				.setPlaceholder(
					cast<string>(t("commands/settings:test.selectPlaceholder")),
				)
				.setMinValues(1)
				.setMaxValues(1)
				.addOptions(
					...buildSubscriptionOptions(selectable, streamerNames, statuses),
				),
		);

	return [selectRow.toJSON()];
}

function buildPageRows(
	state: SettingsMenuState,
	context: SettingsMenuContext,
	t: TFunction<AnyNamespace>,
): SettingsMenuActionRow[] {
	switch (state.page) {
		case "twitch":
			return [
				new ActionRowBuilder<MessageActionRowComponentBuilder>()
					.addComponents(
						...(["add", "manage", "test"] as const).map((page) =>
							new ButtonBuilder()
								.setCustomId(
									buildSettingsCustomId(state.userId, `view:${page}`),
								)
								.setLabel(
									cast<string>(
										t(`commands/settings:menu.options.${page}.label`),
									),
								)
								.setStyle(ButtonStyle.Secondary),
						),
					)
					.toJSON(),
			];

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
							.setCustomId(buildSettingsCustomId(state.userId, "add:open"))
							.setLabel(
								cast<string>(t("commands/settings:menu.options.add.label")),
							)
							.setStyle(ButtonStyle.Secondary),
					)
					.toJSON(),
			];
		default:
			return [];
	}
}

export function buildSettingsMenu(
	state: SettingsMenuState,
	t: TFunction<AnyNamespace>,
	context: SettingsMenuContext = EmptySettingsMenuContext,
): SettingsMenuPayload {
	const container = new ContainerBuilder()
		.setAccentColor(9_520_895)
		.addTextDisplayComponents((textDisplay) =>
			textDisplay.setContent(renderPage(state, t)),
		)
		.addSeparatorComponents((separator) => separator)
		.addActionRowComponents(
			buildSettingsNavigation(state.userId, state.page, t),
		);

	const pageRows = buildPageRows(state, context, t);
	if (pageRows.length > 0) {
		container.addActionRowComponents(...pageRows);
	}

	if (
		(state.page === "manage" || state.page === "test") &&
		context.subscriptions.length > MaximumSelectOptions
	) {
		const page = getSettingsPageIndex(state, context.subscriptions.length);
		const pages = Math.ceil(
			context.subscriptions.length / MaximumSelectOptions,
		);
		container.addActionRowComponents((row) =>
			row.addComponents(
				new ButtonBuilder()
					.setCustomId(
						buildSettingsCustomId(
							state.userId,
							`${state.page}:page:${Math.max(0, page - 1)}`,
						),
					)
					.setLabel(cast<string>(t("commands/settings:social.previous")))
					.setStyle(ButtonStyle.Secondary)
					.setDisabled(page === 0),
				new ButtonBuilder()
					.setCustomId(buildSettingsCustomId(state.userId, "pageIndicator"))
					.setLabel(`${page + 1} / ${pages}`)
					.setStyle(ButtonStyle.Secondary)
					.setDisabled(true),
				new ButtonBuilder()
					.setCustomId(
						buildSettingsCustomId(
							state.userId,
							`${state.page}:page:${page + 1}`,
						),
					)
					.setLabel(cast<string>(t("commands/settings:social.next")))
					.setStyle(ButtonStyle.Secondary)
					.setDisabled(page === pages - 1),
			),
		);
	}

	container.addActionRowComponents((row) =>
		row.setComponents(
			new ButtonBuilder()
				.setCustomId(buildSettingsCustomId(state.userId, "close"))
				.setLabel(cast<string>(t("commands/settings:menu.close")))
				.setEmoji({ name: "⏹️" })
				.setStyle(ButtonStyle.Secondary),
		),
	);

	return {
		components: [container.toJSON()],
		flags: MessageFlags.IsComponentsV2,
		allowed_mentions: { parse: [] },
	};
}

export function buildClosedSettingsMenu(
	t: TFunction<AnyNamespace>,
): SettingsMenuPayload {
	const container = new ContainerBuilder()
		.setAccentColor(5_793_266)
		.addTextDisplayComponents((textDisplay) =>
			textDisplay.setContent(cast<string>(t("commands/settings:closed"))),
		);

	return {
		components: [container.toJSON()],
		flags: MessageFlags.IsComponentsV2,
		allowed_mentions: { parse: [] },
	};
}

function renderPage(
	{ page, subscriptionCount, notice }: SettingsMenuState,
	t: TFunction<AnyNamespace>,
): string {
	return cast<string>(
		t(`commands/settings:pages.${page}`, {
			count: subscriptionCount,
			notice: notice ?? "",
		}),
	);
}

export function buildSettingsNavigation(
	userId: string,
	page: string,
	t: TFunction<AnyNamespace>,
) {
	return new ActionRowBuilder<StringSelectMenuBuilder>().setComponents(
		new StringSelectMenuBuilder()
			.setCustomId(buildSettingsCustomId(userId, "navigate"))
			.setPlaceholder(cast<string>(t("commands/settings:menu.placeholder")))
			.addOptions(
				...(["overview", "twitch"] as const).map((value) => ({
					label: cast<string>(
						t(`commands/settings:menu.options.${value}.label`),
					),
					value,
					default:
						value === page ||
						(value === "twitch" && ["add", "manage", "test"].includes(page)),
				})),
				...SocialProviders.map(({ name }) => ({
					label: cast<string>(
						t(
							cast<"commands/social:providerRss">(
								`commands/social:provider${name}`,
							),
						),
					),
					value: `social:${name}`,
					default: page === `social:${name}`,
				})),
			),
	);
}

function getSettingsPageIndex(state: SettingsMenuState, count: number) {
	const requested = state.pageIndex ?? 0;
	return Number.isSafeInteger(requested)
		? Math.max(
				0,
				Math.min(requested, Math.ceil(count / MaximumSelectOptions) - 1),
			)
		: 0;
}
