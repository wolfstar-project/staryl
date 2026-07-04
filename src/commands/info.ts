import type { TFunction } from "@wolfstar/http-framework-i18n";
import type {
	APIActionRowComponent,
	APIComponentInMessageActionRow,
	APIEmbedField,
} from "discord-api-types/v10";
import type { CpuInfo } from "node:os";
import { cpus, uptime } from "node:os";
import { EmbedBuilder, time, TimestampStyles } from "@discordjs/builders";
import { Command, RegisterCommand } from "@wolfstar/http-framework";
import {
	applyLocalizedBuilder,
	getSupportedUserLanguageT,
} from "@wolfstar/http-framework-i18n";
import {
	getInvite,
	getRepository,
	LanguageKeys,
} from "@wolfstar/shared-http-pieces";
import {
	ButtonStyle,
	ComponentType,
	MessageFlags,
} from "discord-api-types/v10";

const Root = LanguageKeys.Commands.Shared;

@RegisterCommand((builder) =>
	applyLocalizedBuilder(builder, "commands/shared:info"),
)
export class UserCommand extends Command {
	public override chatInputRun(interaction: Command.ChatInputInteraction) {
		const t = getSupportedUserLanguageT(interaction);
		const embed = new EmbedBuilder()
			.setDescription(t(Root.InfoEmbedDescription))
			.addFields(this.getUptimeStatistics(t), this.getServerUsageStatistics(t));
		const components = this.getComponents(t);

		return interaction.reply({
			embeds: [embed.toJSON()],
			components,
			flags: MessageFlags.Ephemeral,
		});
	}

	private getUptimeStatistics(t: TFunction): APIEmbedField {
		const now = Date.now();
		const nowSeconds = Math.round(now / 1000);

		return {
			name: t(Root.InfoFieldUptimeTitle),
			value: t(Root.InfoFieldUptimeValue, {
				host: time(
					Math.round(nowSeconds - uptime()),
					TimestampStyles.RelativeTime,
				),
				client: time(
					Math.round(nowSeconds - process.uptime()),
					TimestampStyles.RelativeTime,
				),
			}),
		};
	}

	private getServerUsageStatistics(t: TFunction): APIEmbedField {
		const usage = process.memoryUsage();

		return {
			name: t(Root.InfoFieldServerUsageTitle),
			value: t(Root.InfoFieldServerUsageValue, {
				cpu: cpus().map(UserCommand.formatCpuInfo).join(" | "),
				heapUsed: (usage.heapUsed / 1_048_576).toLocaleString(t.lng, {
					maximumFractionDigits: 2,
				}),
				heapTotal: (usage.heapTotal / 1_048_576).toLocaleString(t.lng, {
					maximumFractionDigits: 2,
				}),
			}),
		};
	}

	private getComponents(t: TFunction) {
		const url = getInvite();
		const support = this.getSupportComponent(t);
		const github = this.getGitHubComponent(t);
		const donate = this.getDonateComponent(t);
		if (!url) return [this.getActionRow(support, github, donate)];
		return [
			this.getActionRow(support, this.getInviteComponent(t, url)),
			this.getActionRow(github, donate),
		];
	}

	private getActionRow(
		...components: APIComponentInMessageActionRow[]
	): APIActionRowComponent<APIComponentInMessageActionRow> {
		return { type: ComponentType.ActionRow, components };
	}

	private getSupportComponent(t: TFunction): APIComponentInMessageActionRow {
		return {
			type: ComponentType.Button,
			style: ButtonStyle.Link,
			label: t(Root.InfoButtonSupport),
			emoji: { name: "🆘" },
			url: "https://discord.gg/6gakFR2",
		};
	}

	private getInviteComponent(
		t: TFunction,
		url: string,
	): APIComponentInMessageActionRow {
		return {
			type: ComponentType.Button,
			style: ButtonStyle.Link,
			label: t(Root.InfoButtonInvite),
			emoji: { name: "🎉" },
			url,
		};
	}

	private getGitHubComponent(t: TFunction): APIComponentInMessageActionRow {
		return {
			type: ComponentType.Button,
			style: ButtonStyle.Link,
			label: t(Root.InfoButtonGitHub),
			emoji: { name: "🐙" },
			url: getRepository(),
		};
	}

	private getDonateComponent(t: TFunction): APIComponentInMessageActionRow {
		return {
			type: ComponentType.Button,
			style: ButtonStyle.Link,
			label: t(Root.InfoButtonDonate),
			emoji: { name: "🧡" },
			url: "https://donate.wolfstar.rocks",
		};
	}

	private static formatCpuInfo({ times }: CpuInfo) {
		return `${Math.round(((times.user + times.nice + times.sys + times.irq) / times.idle) * 10_000) / 100}%`;
	}
}
