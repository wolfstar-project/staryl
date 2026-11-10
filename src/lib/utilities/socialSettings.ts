import type { SocialProviderName } from "#generated/prisma";
import type { GuildSocialSubscriptionWithSource } from "#social/subscriptions";
import type { AnyNamespace, TFunction } from "@wolfstar/plugin-i18next";
import { getActiveFilters, parseSocialFilters } from "#social/filters";
import { escapeInlineText } from "#social/notifications";
import { getSocialProvider, SocialProviders } from "#social/registry";
import { describeSourceHealth } from "#social/schedule";
import { buildSettingsCustomId } from "#utils/settingsMenu";
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
	MessageFlags,
	TextInputStyle,
} from "discord-api-types/v10";

export const SettingsPageSize = 25;

export function parseSettingsProvider(
	value: string,
): SocialProviderName | null {
	return SocialProviders.find(({ name }) => name === value)?.name ?? null;
}

export function buildSocialSettingsModal(
	owner: string,
	provider: SocialProviderName,
	t: TFunction<AnyNamespace>,
	subscription?: GuildSocialSubscriptionWithSource,
) {
	const modal = new ModalBuilder()
		.setCustomId(
			buildSettingsCustomId(
				owner,
				subscription
					? `social:save:${provider}:${subscription.channelId}:${subscription.sourceId}`
					: `social:add:${provider}`,
			),
		)
		.setTitle(
			cast<string>(
				t(
					subscription
						? "commands/settings:social.edit"
						: "commands/settings:social.add",
				),
			),
		);
	if (!subscription) {
		modal.addLabelComponents(
			(label) =>
				label
					.setLabel(cast<string>(t("commands/settings:social.target")))
					.setTextInputComponent((input) =>
						input
							.setCustomId("target")
							.setStyle(TextInputStyle.Short)
							.setRequired(true)
							.setMaxLength(512),
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
		);
	}
	modal.addLabelComponents((label) =>
		label
			.setLabel(cast<string>(t("commands/settings:modal.message.label")))
			.setTextInputComponent((input) => {
				input
					.setCustomId("message")
					.setStyle(TextInputStyle.Paragraph)
					.setRequired(false)
					.setMaxLength(200);
				if (subscription?.message) input.setValue(subscription.message);
				return input;
			}),
	);
	return modal.toJSON();
}

export function buildSocialSettingsPage(
	options: {
		owner: string;
		provider: SocialProviderName;
		subscriptions: GuildSocialSubscriptionWithSource[];
		page?: number;
		selected?: string;
		confirming?: boolean;
		notice?: string;
	},
	t: TFunction<AnyNamespace>,
	navigation: ActionRowBuilder<StringSelectMenuBuilder>,
) {
	const { owner, provider, subscriptions } = options;
	const pages = Math.max(1, Math.ceil(subscriptions.length / SettingsPageSize));
	const page = Math.min(Math.max(0, options.page ?? 0), pages - 1);
	const id = (action: string) => {
		const [verb, ...args] = action.split(":");
		return buildSettingsCustomId(
			owner,
			["social", verb, provider, ...args].join(":"),
		);
	};
	const label = (key: string) =>
		cast<string>(
			t(
				cast<"commands/settings:social.add">(`commands/settings:social.${key}`),
			),
		);
	const button = (action: string, key: string, danger = false) =>
		new ButtonBuilder()
			.setCustomId(id(action))
			.setLabel(label(key))
			.setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Secondary);
	const container = new ContainerBuilder()
		.setAccentColor(5_793_266)
		.addTextDisplayComponents((text) =>
			text.setContent(
				`## ${label("title")} › ${t(cast<"commands/social:providerRss">(`commands/social:provider${provider}`))}\n${options.notice ?? ""}\n${t("commands/settings:social.count", { count: subscriptions.length })}`,
			),
		)
		.addActionRowComponents(navigation)
		.addSeparatorComponents((separator) => separator);
	const configured =
		getSocialProvider(provider)?.getAuthRequirements().satisfied;
	const connected = provider === "Instagram" || provider === "TikTok";
	if (!configured)
		container.addTextDisplayComponents((text) =>
			text.setContent(
				cast<string>(t("commands/social:addProviderNotConfigured")),
			),
		);
	if (connected)
		container.addTextDisplayComponents((text) =>
			text.setContent(
				cast<string>(
					t("commands/settings:social.connect", {
						provider: provider.toLowerCase(),
					}),
				),
			),
		);
	const visible = subscriptions.slice(
		page * SettingsPageSize,
		(page + 1) * SettingsPageSize,
	);
	if (visible.length) {
		container.addActionRowComponents((row) =>
			row.setComponents(
				new StringSelectMenuBuilder()
					.setCustomId(id(`select:${page}`))
					.setPlaceholder(label("select"))
					.addOptions(
						visible.map((subscription) => ({
							label: subscription.source.displayName.slice(0, 100),
							description:
								`#${subscription.channelId} • ${describeSettingsSubscription(subscription, t)}`.slice(
									0,
									100,
								),
							value: `${subscription.channelId}:${subscription.sourceId}`,
						})),
					),
			),
		);
	} else
		container.addTextDisplayComponents((text) =>
			text.setContent(cast<string>(t("commands/settings:manage.empty"))),
		);
	const selected = subscriptions.find(
		(s) => `${s.channelId}:${s.sourceId}` === options.selected,
	);
	if (selected) {
		const key = `${selected.channelId}:${selected.sourceId}`;
		container.addTextDisplayComponents((text) =>
			text.setContent(
				`### ${escapeInlineText(selected.source.displayName)}\n${channelMention(String(selected.channelId))}\n${label("target")}: ${escapeInlineText(selected.source.target).slice(0, 600)}\n${label("message")}: ${selected.message ? escapeInlineText(selected.message) : label("defaultMessage")}\n${label("status")}: ${describeSettingsSubscription(selected, t)}\n${label("filters")}: ${describeSettingsFilters(selected.filters, t)}`,
			),
		);
		container.addActionRowComponents((row) =>
			row.addComponents(
				button(`edit:${key}`, "edit"),
				button(`test:${key}`, "test"),
				button(
					`${options.confirming ? "remove" : "confirm"}:${key}`,
					options.confirming ? "confirm" : "remove",
					true,
				),
			),
		);
	}
	container.addActionRowComponents((row) =>
		row.addComponents(
			button("open", "add").setDisabled(!configured || connected),
			button(`page:${page}`, "refresh"),
			new ButtonBuilder()
				.setCustomId(buildSettingsCustomId(owner, "close"))
				.setLabel(cast<string>(t("commands/settings:menu.close")))
				.setStyle(ButtonStyle.Secondary),
		),
	);
	if (pages > 1)
		container.addActionRowComponents((row) =>
			row.addComponents(
				button(`page:${page - 1}`, "previous").setDisabled(page === 0),
				new ButtonBuilder()
					.setCustomId(id("pageIndicator"))
					.setLabel(`${page + 1} / ${pages}`)
					.setStyle(ButtonStyle.Secondary)
					.setDisabled(true),
				button(`page:${page + 1}`, "next").setDisabled(page === pages - 1),
			),
		);
	return {
		components: [container.toJSON()],
		flags: MessageFlags.IsComponentsV2 as const,
		allowed_mentions: { parse: [] },
	};
}

function describeSettingsSubscription(
	subscription: GuildSocialSubscriptionWithSource,
	t: TFunction<AnyNamespace>,
): string {
	if (subscription.deliveryError)
		return cast<string>(
			t(`commands/social:deliveryErrors.${subscription.deliveryError}`),
		);
	const health = getSocialProvider(
		subscription.source.provider,
	)?.getAuthRequirements().satisfied
		? describeSourceHealth(subscription.source)
		: "unavailable";
	return cast<string>(t(`commands/social:health.${health}`));
}

function describeSettingsFilters(
	storedFilters: unknown,
	t: TFunction<AnyNamespace>,
): string {
	const filters = parseSocialFilters(storedFilters);
	const active = getActiveFilters(filters);
	if (!active.length)
		return cast<string>(t("commands/settings:social.noFilters"));
	return active
		.map((key) => {
			const value = filters[key];
			return `${t(`commands/settings:filterLabels.${key}`)}: ${escapeInlineText(Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? cast<string>(t("globals:yes")) : String(value))}`;
		})
		.join(" · ")
		.slice(0, 700);
}
