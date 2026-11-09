import type {
	InteractionHandler,
	ModalSubmitInteraction,
} from "@wolfstar/http-framework";
import type { AnyNamespace, TFunction } from "@wolfstar/plugin-i18next";
import { DefaultSocialFilters } from "#social/filters";
import {
	addSocialSubscription,
	getGuildSocialSubscriptions,
	removeSocialSubscription,
	testSocialSubscription,
} from "#social/subscriptions";
import { DeliveryErrorKeys } from "#twitch/subscriptions";
import { buildSettingsNavigation } from "#utils/settingsMenu";
import {
	buildSocialSettingsModal,
	buildSocialSettingsPage,
	parseSettingsProvider,
} from "#utils/socialSettings";
import { Result } from "@sapphire/result";
import { cast } from "@sapphire/utilities";
import { container } from "@wolfstar/http-framework";
import {
	ComponentType,
	InteractionType,
	MessageFlags,
} from "discord-api-types/v10";

export async function handleSocialSettings(
	interaction: InteractionHandler.Interaction,
	owner: string,
	action: string,
	t: TFunction<AnyNamespace>,
) {
	const [, verb, providerValue, first, second] = action.split(":");
	const provider = parseSettingsProvider(providerValue ?? "");
	const invalid = () =>
		interaction.reply({
			content: t("commands/settings:errors.invalid"),
			flags: MessageFlags.Ephemeral,
		});
	if (!provider) return invalid();
	if (
		![
			"open",
			"page",
			"select",
			"edit",
			"add",
			"save",
			"confirm",
			"remove",
			"test",
		].includes(verb ?? "")
	)
		return invalid();

	if (verb === "open" && interaction.type !== InteractionType.ModalSubmit)
		return interaction.showModal(buildSocialSettingsModal(owner, provider, t));

	if (
		interaction.type === InteractionType.ModalSubmit &&
		verb !== "add" &&
		verb !== "save"
	)
		return invalid();
	if (verb === "edit" && interaction.type !== InteractionType.ModalSubmit) {
		const loaded = await getGuildSocialSubscriptions(
			BigInt(interaction.guildId!),
		);
		if (loaded.isErr()) {
			container.logger.error(
				"[settings] Failed to open message editor",
				loaded.unwrapErr(),
			);
			return invalid();
		}
		const subscription = loaded
			.unwrap()
			.find(
				(s) =>
					s.source.provider === provider &&
					String(s.channelId) === first &&
					String(s.sourceId) === second,
			);
		return subscription
			? interaction.showModal(
					buildSocialSettingsModal(owner, provider, t, subscription),
				)
			: invalid();
	}

	// Every remaining branch may read the database or call a provider.
	const deferred = await interaction.deferUpdate();
	const loaded = await getGuildSocialSubscriptions(
		BigInt(interaction.guildId!),
	);
	if (loaded.isErr()) {
		container.logger.error(
			"[settings] Failed to load social subscriptions",
			loaded.unwrapErr(),
		);
		return deferred.update(
			buildSocialSettingsPage(
				{
					owner,
					provider,
					subscriptions: [],
					notice: cast<string>(t("commands/twitch:testFailed")),
				},
				t,
				buildSettingsNavigation(owner, `social:${provider}`, t),
			),
		);
	}
	const subscriptions = loaded
		.unwrap()
		.filter((s) => s.source.provider === provider);
	let selected = first && second ? `${first}:${second}` : undefined;
	let page = verb === "page" || verb === "select" ? Number(first) : 0;
	if (!Number.isSafeInteger(page) || page < 0) page = 0;
	if (
		verb === "select" &&
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.component_type === ComponentType.StringSelect
	) {
		selected = cast<string[]>(
			cast<InteractionHandler.SelectMenuInteraction>(interaction).values,
		)[0];
	}
	const subscription = subscriptions.find(
		(s) => `${s.channelId}:${s.sourceId}` === selected,
	);
	let notice: string | undefined =
		["select", "confirm", "remove", "test", "save"].includes(verb ?? "") &&
		!subscription
			? cast<string>(t("commands/settings:errors.sectionUnavailable"))
			: undefined;
	let confirming = false;
	if (
		interaction.type === InteractionType.ModalSubmit &&
		(verb === "add" || verb === "save")
	) {
		const fields = new Map<string, string | string[]>();
		for (const label of cast<ModalSubmitInteraction>(interaction).data
			.components) {
			if (label.type !== ComponentType.Label) continue;
			const field = cast<{
				custom_id: string;
				value?: string;
				values?: string[];
			}>(label.component);
			fields.set(field.custom_id, field.value ?? field.values ?? "");
		}
		const messageValue = fields.get("message");
		const message =
			typeof messageValue === "string" && messageValue.length
				? messageValue
				: null;
		if ((message?.length ?? 0) > 200)
			notice = cast<string>(t("commands/settings:errors.invalid"));
		else if (verb === "add") {
			const target = fields.get("target");
			const channels = fields.get("channel");
			const channelId = Array.isArray(channels) ? channels[0] : undefined;
			if (
				typeof target !== "string" ||
				!target.trim() ||
				!channelId ||
				!/^\d{1,20}$/.test(channelId)
			)
				notice = cast<string>(t("commands/settings:errors.invalid"));
			else {
				const result = await addSocialSubscription({
					guildId: BigInt(interaction.guildId!),
					channelId: BigInt(channelId),
					providerName: provider,
					input: target,
					message,
					filters: DefaultSocialFilters,
				});
				notice = result.isErr()
					? cast<string>(t(result.unwrapErr()))
					: cast<string>(
							t("commands/social:addSuccess", {
								GREENTICK: "✅",
								name: result.unwrap().displayName,
								channel: `<#${channelId}>`,
							}),
						);
			}
		} else if (subscription) {
			const result = await Result.fromAsync(() =>
				container.prisma.guildSocialSubscription.update({
					where: {
						guildId_channelId_sourceId: {
							guildId: subscription.guildId,
							channelId: subscription.channelId,
							sourceId: subscription.sourceId,
						},
					},
					data: { message },
				}),
			);
			if (result.isErr())
				container.logger.error(
					"[settings] Failed to save message",
					result.unwrapErr(),
				);
			notice = cast<string>(
				t(
					result.isErr()
						? "commands/social:removeFailed"
						: "commands/settings:social.saved",
				),
			);
		} else
			notice = cast<string>(t("commands/settings:errors.sectionUnavailable"));
	} else if (verb === "confirm" && subscription) {
		confirming = true;
		notice = cast<string>(t("commands/settings:social.confirmNotice"));
	} else if (verb === "remove" && subscription) {
		const result = await removeSocialSubscription({
			guildId: subscription.guildId,
			channelId: subscription.channelId,
			sourceId: subscription.sourceId,
		});
		if (result.isErr())
			container.logger.error(
				"[settings] Failed to remove subscription",
				result.unwrapErr(),
			);
		notice = cast<string>(
			t(
				result.isErr()
					? "commands/social:removeFailed"
					: "commands/settings:social.removed",
			),
		);
	} else if (verb === "test" && subscription) {
		const result = await testSocialSubscription(
			subscription,
			cast<string>(t("events/social:testNotice")),
		);
		const keys = {
			...DeliveryErrorKeys,
			providerNotConfigured: "commands/social:addProviderNotConfigured",
			targetUnreachable: "commands/social:addTargetUnreachable",
			noItems: "commands/social:testNoItems",
		} as const;
		notice = cast<string>(
			t(
				result.isErr()
					? keys[result.unwrapErr()]
					: "commands/twitch:testSuccess",
				{
					REDCROSS: "❌",
					GREENTICK: "✅",
					channel: `<#${subscription.channelId}>`,
				},
			),
		);
	}
	const refreshed = await getGuildSocialSubscriptions(
		BigInt(interaction.guildId!),
	);
	if (refreshed.isErr()) {
		container.logger.error(
			"[settings] Failed to refresh social subscriptions",
			refreshed.unwrapErr(),
		);
		notice = cast<string>(t("commands/twitch:testFailed"));
	}
	return deferred.update(
		buildSocialSettingsPage(
			{
				owner,
				provider,
				subscriptions: refreshed
					.unwrapOr([])
					.filter((s) => s.source.provider === provider),
				selected,
				page,
				confirming,
				notice,
			},
			t,
			buildSettingsNavigation(owner, `social:${provider}`, t),
		),
	);
}
