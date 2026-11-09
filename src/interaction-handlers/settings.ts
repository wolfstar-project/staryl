import type { SettingsMenuContext } from "#utils/settingsMenu";
import type { ModalSubmitInteraction } from "@wolfstar/http-framework";
import type { AnyNamespace, TFunction } from "@wolfstar/plugin-i18next";
import type { APIModalSubmissionComponent } from "discord-api-types/v10";
import { TwitchSubscriptionType } from "#generated/prisma";
import {
	addSubscription,
	DeliveryErrorKeys,
	fetchStreamerNames,
	getGuildSubscriptions,
	getStreamerById,
	resetGuildSubscriptions,
	testSubscriptionDelivery,
} from "#twitch/subscriptions";
import { getSettingsSubscriptionCount } from "#utils/settingsCounts";
import {
	buildAddModal,
	buildClosedSettingsMenu,
	buildSettingsMenu,
	buildSubscriptionKey,
	isSettingsPage,
	parseSubscriptionKey,
} from "#utils/settingsMenu";
import { handleSocialSettings } from "#utils/socialSettingsActions";
import { channelMention } from "@discordjs/formatters";
import { cast } from "@sapphire/utilities";
import { InteractionHandler } from "@wolfstar/http-framework";
import { getSupportedLanguageT } from "@wolfstar/plugin-i18next";
import {
	ComponentType,
	InteractionType,
	MessageFlags,
	PermissionFlagsBits,
} from "discord-api-types/v10";

/**
 * Whether the interacting member currently holds Manage Server (or Administrator, which implies
 * it), re-checked on every privileged action instead of trusting the owner id alone: `/settings` is
 * Manage Server-gated at invocation, but a still-open menu outlives that single check, so a member
 * who loses the role afterwards must not keep the ability to add, remove, reset, or test
 * subscriptions through it.
 *
 * Discord already expands Administrator into every permission bit in `member.permissions`; testing
 * the bit explicitly keeps that from being an assumption this check silently depends on.
 */
function hasManageGuildPermission(
	interaction: InteractionHandler.Interaction,
): boolean {
	const permissions = interaction.member?.permissions;
	if (typeof permissions !== "string") return false;

	const bits = BigInt(permissions);
	return (
		(bits & PermissionFlagsBits.ManageGuild) ===
			PermissionFlagsBits.ManageGuild ||
		(bits & PermissionFlagsBits.Administrator) ===
			PermissionFlagsBits.Administrator
	);
}

/**
 * Reads every field of a modal submission keyed by its `custom_id`.
 *
 * `buildAddModal` wraps each field in a `LabelBuilder`, so every entry in `components` is a
 * `Label` wrapping either a text input (`.value`) or a select menu (`.values`); there is no
 * legacy action-row-of-text-inputs shape to account for.
 */
function collectModalFields(
	components: APIModalSubmissionComponent[],
): Map<string, string | string[]> {
	const fields = new Map<string, string | string[]>();
	for (const entry of components) {
		if (entry.type !== ComponentType.Label) continue;

		const field = cast<{
			custom_id: string;
			value?: string;
			values?: string[];
		}>(entry.component);
		fields.set(field.custom_id, field.value ?? field.values ?? "");
	}

	return fields;
}

export class UserInteractionHandler extends InteractionHandler {
	public override async run(
		interaction: InteractionHandler.Interaction,
		customIdValue: unknown,
	) {
		const t = cast<TFunction<AnyNamespace>>(getSupportedLanguageT(interaction));
		const customIdParts = Array.isArray(customIdValue) ? customIdValue : [];
		const [ownerId, action] = customIdParts;
		if (typeof ownerId !== "string" || typeof action !== "string") {
			return interaction.reply({
				content: t("commands/settings:errors.invalid"),
				flags: MessageFlags.Ephemeral,
			});
		}

		if (interaction.user.id !== ownerId) {
			return interaction.reply({
				content: t("commands/settings:errors.ownerOnly"),
				flags: MessageFlags.Ephemeral,
			});
		}

		if (!hasManageGuildPermission(interaction)) {
			return interaction.reply({
				content: t("commands/settings:errors.permissionRevoked"),
				flags: MessageFlags.Ephemeral,
			});
		}

		const pageMatch = /^(manage|test):page:(\d+)$/.exec(action);
		if (pageMatch) {
			const deferred = await interaction.deferUpdate();
			const loaded = await this.#loadManageContext(interaction, t);
			return deferred.update(
				buildSettingsMenu(
					{
						page: pageMatch[1] as "manage" | "test",
						userId: ownerId,
						subscriptionCount: loaded.count,
						pageIndex: Number(pageMatch[2]),
						notice: loaded.loadFailed
							? cast<string>(t("commands/twitch:testFailed"))
							: undefined,
					},
					t,
					loaded.context,
				),
			);
		}

		if (action.startsWith("social:"))
			return handleSocialSettings(interaction, ownerId, action, t);

		// The modal submission for "add:submit" is routed to this same handler; every other action
		// only ever arrives as a message component interaction.
		if (interaction.type === InteractionType.ModalSubmit) {
			if (action !== "add:submit") {
				return interaction.reply({
					content: t("commands/settings:errors.actionUnavailable"),
					flags: MessageFlags.Ephemeral,
				});
			}

			return this.#handleAddSubmit(interaction, ownerId, t);
		}

		if (["view:add", "view:manage", "view:test"].includes(action))
			return this.#handleNavigate(interaction, ownerId, t, action.slice(5));
		if (action === "close")
			return interaction.update(buildClosedSettingsMenu(t));
		if (action === "navigate")
			return this.#handleNavigate(interaction, ownerId, t);
		if (action === "add:open") {
			return interaction.showModal(buildAddModal(ownerId, t).data);
		}
		if (action === "manage:select") {
			return this.#handleManageSelect(interaction, ownerId, t);
		}
		if (action === "manage:reset:open") {
			return this.#handleManageResetOpen(interaction, ownerId, t);
		}
		if (action === "manage:reset:confirm") {
			return this.#handleManageResetConfirm(interaction, ownerId, t);
		}
		const testSelect = /^test:select(?::(\d+))?$/.exec(action);
		if (testSelect) {
			return this.#handleTestSelect(
				interaction,
				ownerId,
				t,
				Number(testSelect[1] ?? 0),
			);
		}

		return interaction.reply({
			content: t("commands/settings:errors.actionUnavailable"),
			flags: MessageFlags.Ephemeral,
		});
	}

	async #handleNavigate(
		interaction: InteractionHandler.Interaction,
		ownerId: string,
		t: TFunction<AnyNamespace>,
		requestedPage?: string,
	) {
		const selectInteraction =
			cast<InteractionHandler.SelectMenuInteraction>(interaction);
		if (
			!requestedPage &&
			selectInteraction.data.component_type !== ComponentType.StringSelect
		) {
			return interaction.reply({
				content: t("commands/settings:errors.actionUnavailable"),
				flags: MessageFlags.Ephemeral,
			});
		}

		const page = requestedPage ?? cast<string[]>(selectInteraction.values)[0];
		if (page?.startsWith("social:"))
			return handleSocialSettings(
				interaction,
				ownerId,
				`social:page:${page.slice(7)}:0`,
				t,
			);
		if (page === undefined || !isSettingsPage(page)) {
			return interaction.reply({
				content: t("commands/settings:errors.sectionUnavailable"),
				flags: MessageFlags.Ephemeral,
			});
		}

		// Acknowledge before loading Manage/Test data: the same expiry risk as the command's initial
		// count query applies here, since a component interaction has the same short response window.
		const deferred = await interaction.deferUpdate();

		if (page === "manage" || page === "test") {
			const { count, context } = await this.#loadManageContext(interaction, t);
			return deferred.update(
				buildSettingsMenu(
					{ page, subscriptionCount: count, userId: ownerId },
					t,
					context,
				),
			);
		}

		const count = await this.#getSubscriptionCount(interaction);
		return deferred.update(
			buildSettingsMenu({ page, subscriptionCount: count, userId: ownerId }, t),
		);
	}

	async #handleAddSubmit(
		interaction: InteractionHandler.Interaction,
		ownerId: string,
		t: TFunction<AnyNamespace>,
	) {
		const modalInteraction = cast<ModalSubmitInteraction>(interaction);
		const fields = collectModalFields(modalInteraction.data.components);

		const streamerField = fields.get("streamer");
		const streamerLogin =
			typeof streamerField === "string" ? streamerField : "";

		const channelField = fields.get("channel");
		const channelId = Array.isArray(channelField) ? channelField[0] : undefined;

		const typeField = fields.get("type");
		const type = cast<TwitchSubscriptionType>(
			Array.isArray(typeField) ? typeField[0] : undefined,
		);

		const messageField = fields.get("message");
		const message =
			typeof messageField === "string" && messageField.length > 0
				? messageField
				: null;

		if (channelId === undefined || streamerLogin.length === 0) {
			const count = await this.#getSubscriptionCount(interaction);
			return modalInteraction.update(
				buildSettingsMenu(
					{
						page: "add",
						subscriptionCount: count,
						userId: ownerId,
						notice: cast<string>(t("commands/settings:errors.invalid")),
					},
					t,
				),
			);
		}

		const result = await addSubscription(
			BigInt(interaction.guildId!),
			BigInt(channelId),
			streamerLogin,
			type,
			message,
		);

		if (result.isErr()) {
			const notice = cast<string>(t(result.unwrapErr()));
			const count = await this.#getSubscriptionCount(interaction);
			return modalInteraction.update(
				buildSettingsMenu(
					{ page: "add", subscriptionCount: count, userId: ownerId, notice },
					t,
				),
			);
		}

		const { streamer } = result.unwrap();
		const notice = t(
			type === TwitchSubscriptionType.StreamOnline
				? "commands/twitch:addSuccessLive"
				: "commands/twitch:addSuccessOffline",
			{
				GREENTICK: "✅",
				name: streamer.display_name,
				channel: channelMention(channelId),
			},
		);
		const count = await this.#getSubscriptionCount(interaction);
		return modalInteraction.update(
			buildSettingsMenu(
				{ page: "add", subscriptionCount: count, userId: ownerId, notice },
				t,
			),
		);
	}

	async #handleManageSelect(
		interaction: InteractionHandler.Interaction,
		ownerId: string,
		t: TFunction<AnyNamespace>,
	) {
		const selectInteraction =
			cast<InteractionHandler.SelectMenuInteraction>(interaction);
		if (selectInteraction.data.component_type !== ComponentType.StringSelect) {
			return interaction.reply({
				content: t("commands/settings:errors.actionUnavailable"),
				flags: MessageFlags.Ephemeral,
			});
		}

		const values = cast<string[]>(selectInteraction.values);
		const loaded = await this.#loadManageContext(interaction, t);
		if (loaded.loadFailed) {
			return interaction.update(
				buildSettingsMenu(
					{
						page: "manage",
						subscriptionCount: loaded.count,
						userId: ownerId,
						notice: cast<string>(t("commands/twitch:removeFailed")),
					},
					t,
					loaded.context,
				),
			);
		}

		const { context } = loaded;
		const matched = context.subscriptions.filter((subscription) =>
			values.includes(
				buildSubscriptionKey(
					subscription.channelId,
					subscription.twitchSubscription.id,
				),
			),
		);

		const resetResult = await resetGuildSubscriptions(matched);
		if (resetResult.isErr()) {
			this.container.logger.error(
				`[settings] Failed to remove the selected subscriptions for guild ${interaction.guildId}`,
				resetResult.unwrapErr(),
			);
		}

		const refreshed = await this.#loadManageContext(interaction, t);
		const notice = cast<string>(
			resetResult.isErr()
				? t("commands/twitch:removeFailed")
				: t("commands/settings:manage.removeSuccess", {
						count: matched.length,
					}),
		);
		return interaction.update(
			buildSettingsMenu(
				{
					page: "manage",
					subscriptionCount: refreshed.count,
					userId: ownerId,
					notice,
				},
				t,
				refreshed.context,
			),
		);
	}

	async #handleManageResetOpen(
		interaction: InteractionHandler.Interaction,
		ownerId: string,
		t: TFunction<AnyNamespace>,
	) {
		const { count, context } = await this.#loadManageContext(interaction, t);
		return interaction.update(
			buildSettingsMenu(
				{
					page: "manage",
					subscriptionCount: count,
					userId: ownerId,
					confirmingReset: true,
				},
				t,
				context,
			),
		);
	}

	async #handleManageResetConfirm(
		interaction: InteractionHandler.Interaction,
		ownerId: string,
		t: TFunction<AnyNamespace>,
	) {
		const loaded = await this.#loadManageContext(interaction, t);
		if (loaded.loadFailed) {
			return interaction.update(
				buildSettingsMenu(
					{
						page: "manage",
						subscriptionCount: loaded.count,
						userId: ownerId,
						notice: cast<string>(t("commands/twitch:resetFailed")),
					},
					t,
					loaded.context,
				),
			);
		}

		const { count, context } = loaded;

		const resetResult = await resetGuildSubscriptions(context.subscriptions);
		if (resetResult.isErr()) {
			this.container.logger.error(
				`[settings] Failed to reset the subscriptions for guild ${interaction.guildId}`,
				resetResult.unwrapErr(),
			);
		}

		const refreshed = await this.#loadManageContext(interaction, t);
		const notice = resetResult.isErr()
			? t("commands/twitch:resetFailed")
			: t("commands/twitch:resetSuccess", { GREENTICK: "✅", count });
		return interaction.update(
			buildSettingsMenu(
				{
					page: "manage",
					subscriptionCount: refreshed.count,
					userId: ownerId,
					notice,
				},
				t,
				refreshed.context,
			),
		);
	}

	async #handleTestSelect(
		interaction: InteractionHandler.Interaction,
		ownerId: string,
		t: TFunction<AnyNamespace>,
		pageIndex: number,
	) {
		const selectInteraction =
			cast<InteractionHandler.SelectMenuInteraction>(interaction);
		if (selectInteraction.data.component_type !== ComponentType.StringSelect) {
			return interaction.reply({
				content: t("commands/settings:errors.actionUnavailable"),
				flags: MessageFlags.Ephemeral,
			});
		}

		const value = cast<string[]>(selectInteraction.values)[0];
		const { count, context, loadFailed } = await this.#loadManageContext(
			interaction,
			t,
		);
		const parsed = value === undefined ? null : parseSubscriptionKey(value);
		const subscription = parsed
			? context.subscriptions.find(
					(candidate) =>
						candidate.channelId === parsed.channelId &&
						candidate.twitchSubscription.id === parsed.subscriptionId,
				)
			: undefined;

		let notice: string;
		if (loadFailed) {
			notice = t("commands/twitch:testFailed");
		} else if (!subscription) {
			notice = t("commands/settings:errors.sectionUnavailable");
		} else {
			const streamer = await getStreamerById(
				subscription.twitchSubscription.streamerId,
			);
			if (!streamer) {
				notice = t("commands/twitch:streamerNotFound");
			} else {
				const deliveryResult = await testSubscriptionDelivery(
					subscription,
					streamer,
				);
				notice = t(
					deliveryResult.isErr()
						? DeliveryErrorKeys[deliveryResult.unwrapErr()]
						: "commands/twitch:testSuccess",
					{
						REDCROSS: "❌",
						GREENTICK: "✅",
						channel: channelMention(subscription.channelId.toString()),
					},
				);
			}
		}

		return interaction.update(
			buildSettingsMenu(
				{
					page: "test",
					subscriptionCount: count,
					userId: ownerId,
					notice,
					pageIndex,
				},
				t,
				context,
			),
		);
	}

	async #getSubscriptionCount(
		interaction: InteractionHandler.Interaction,
	): Promise<number> {
		if (!interaction.inGuild()) return 0;

		const result = await getSettingsSubscriptionCount(
			BigInt(interaction.guildId),
		);
		if (result.isErr()) {
			this.container.logger.error(
				`[settings] Failed to refresh subscriptions for guild ${interaction.guildId}`,
				result.unwrapErr(),
			);
		}

		return result.unwrapOr(0);
	}

	/**
	 * Loads everything the Manage and Test pages need to render: the guild's subscriptions, the
	 * streamer display names for them, and the localized live/offline status labels.
	 *
	 * `loadFailed` distinguishes "the guild has no subscriptions" from "the subscriptions could not be
	 * read": callers that mutate (remove selected, reset all) must treat the latter as a hard stop
	 * instead of silently operating on the substituted empty list and reporting success for a change
	 * that never happened.
	 */
	async #loadManageContext(
		interaction: InteractionHandler.Interaction,
		t: TFunction<AnyNamespace>,
	): Promise<{
		count: number;
		context: SettingsMenuContext;
		loadFailed: boolean;
	}> {
		if (!interaction.inGuild()) {
			return {
				count: 0,
				context: {
					subscriptions: [],
					streamerNames: new Map(),
					statuses: { live: "", offline: "" },
				},
				loadFailed: false,
			};
		}

		const guildId = BigInt(interaction.guildId);
		const subscriptionsResult = await getGuildSubscriptions(guildId);
		if (subscriptionsResult.isErr()) {
			this.container.logger.error(
				`[settings] Failed to load subscriptions for guild ${interaction.guildId}`,
				subscriptionsResult.unwrapErr(),
			);
		}

		const subscriptions = subscriptionsResult.unwrapOr([]);
		const streamerNames = await fetchStreamerNames(
			subscriptions.map(
				(subscription) => subscription.twitchSubscription.streamerId,
			),
		);
		const statuses = {
			live: cast<string>(t("commands/twitch:showStatus.live")),
			offline: cast<string>(t("commands/twitch:showStatus.offline")),
		};

		return {
			count: subscriptions.length,
			context: { subscriptions, streamerNames, statuses },
			loadFailed: subscriptionsResult.isErr(),
		};
	}
}
