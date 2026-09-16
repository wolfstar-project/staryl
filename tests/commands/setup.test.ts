import type { GuildSubscriptionWithTwitch } from "#twitch/subscriptions";
import { TwitchSubscriptionType } from "#generated/prisma";
import {
	buildSetupCustomId,
	buildSubscriptionKey,
	SetupInteractionHandlerName,
} from "#utils/setupMenu";
import { VirtualPath } from "@sapphire/pieces";
import { ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import {
	ChatInputApplicationCommandInteractionData,
	createTestHarness,
	makeCommand,
	MessageComponentButtonInteractionData,
	MessageComponentStringSelectInteractionData,
	ModalSubmitInteractionData,
} from "@wolfstar/http-framework-test-utils";
import {
	ApplicationCommandType,
	ComponentType,
	InteractionResponseType,
	PermissionFlagsBits,
} from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UserCommand } from "../../src/commands/subscriptions/setup.ts";
import { UserInteractionHandler } from "../../src/interaction-handlers/setup.ts";

vi.mock("@wolfstar/twitch-helpers", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@wolfstar/twitch-helpers")>();
	return {
		...actual,
		areTwitchEventSubCredentialsSet: vi.fn(),
		fetchUsers: vi.fn(),
		fetchStream: vi.fn(),
		addEventSubscription: vi.fn(),
		removeEventSubscription: vi.fn(),
		getRequest: vi.fn(),
	};
});

const apiMock = vi.hoisted(() => ({
	guilds: {
		get: vi.fn(),
		getChannels: vi.fn(),
		getMember: vi.fn(),
	},
	channels: { createMessage: vi.fn() },
	users: { getCurrent: vi.fn() },
}));

vi.mock("#utils/discordApi", () => ({ api: () => apiMock }));

const {
	areTwitchEventSubCredentialsSet,
	fetchUsers,
	fetchStream,
	addEventSubscription,
	removeEventSubscription,
} = await import("@wolfstar/twitch-helpers");

const OwnerId = "266624760782258186"; // Matches `UserData.id` from the fixtures' member.
const OtherUserId = "999999999999999999";
const GuildId = "737141877803057244"; // Matches `BaseInteractionData.guild_id` from the fixtures.
const ChannelId = "800000000000000001";
const StreamerId = "123456789";
const StreamerDisplayName = "CoolStreamer";
const SubscriptionId = 900n;
const BotRoleId = "900000000000000001";

const prismaMock = {
	guildSubscription: {
		findMany: vi.fn(),
		count: vi.fn(),
		create: vi.fn(),
		delete: vi.fn(),
	},
	twitchSubscription: {
		findFirst: vi.fn(),
		create: vi.fn(),
		delete: vi.fn(),
	},
};

const { runner } = createTestHarness({
	discordPublicKey: "test-discord-public-key",
	discordToken: "test.discord.token",
});

beforeAll(async () => {
	const command = makeCommand(UserCommand);
	await container.stores.get("commands").insert(command);
});

beforeEach(async () => {
	vi.clearAllMocks();
	vi.mocked(areTwitchEventSubCredentialsSet).mockReturnValue(true);
	container.prisma = prismaMock as never;
	prismaMock.guildSubscription.findMany.mockResolvedValue([]);
	prismaMock.guildSubscription.count.mockResolvedValue(0);

	// The handler is looked up by piece `name`, not by a decorator registry, so it must be
	// constructed with the exact name `buildSetupCustomId` encodes in every custom_id.
	const handler = new UserInteractionHandler({
		name: SetupInteractionHandlerName,
		path: VirtualPath,
		root: VirtualPath,
		store: container.stores.get("interaction-handlers"),
	});
	await container.stores.get("interaction-handlers").insert(handler);
});

function grantChannelPermissions(permissions: bigint) {
	apiMock.guilds.get.mockResolvedValue({
		preferred_locale: "en-US",
		roles: [
			{ id: GuildId, permissions: "0" },
			{ id: BotRoleId, permissions: String(permissions) },
		],
	});
	apiMock.guilds.getChannels.mockResolvedValue([
		{ id: ChannelId, name: "general", type: 0, guild_id: GuildId },
	]);
	apiMock.users.getCurrent.mockResolvedValue({ id: "bot-id" });
	apiMock.guilds.getMember.mockResolvedValue({ roles: [BotRoleId] });
	apiMock.channels.createMessage.mockResolvedValue({ id: "1" });
}

function buildSubscription(
	overrides: Partial<GuildSubscriptionWithTwitch> = {},
): GuildSubscriptionWithTwitch {
	return {
		guildId: BigInt(GuildId),
		channelId: BigInt(ChannelId),
		subscriptionId: SubscriptionId,
		message: "Hey, we are live!",
		twitchSubscription: {
			id: SubscriptionId,
			streamerId: StreamerId,
			subscriptionId: "event-900",
			subscriptionType: TwitchSubscriptionType.StreamOnline,
		},
		...overrides,
	} as GuildSubscriptionWithTwitch;
}

function buttonInteraction(action: string, userId = OwnerId) {
	return {
		...MessageComponentButtonInteractionData,
		data: {
			...MessageComponentButtonInteractionData.data,
			custom_id: buildSetupCustomId(userId, action),
		},
	};
}

function selectInteraction(action: string, values: string[], userId = OwnerId) {
	return {
		...MessageComponentStringSelectInteractionData,
		data: {
			...MessageComponentStringSelectInteractionData.data,
			custom_id: buildSetupCustomId(userId, action),
			values,
		},
	};
}

function modalInteraction(
	fields: { custom_id: string; value?: string; values?: string[] }[],
	userId = OwnerId,
) {
	return {
		...ModalSubmitInteractionData,
		data: {
			...ModalSubmitInteractionData.data,
			custom_id: buildSetupCustomId(userId, "add:submit"),
			components: fields.map((field) => ({
				type: ComponentType.Label,
				component: field,
			})),
		},
	};
}

describe("setup interaction handler: owner check", () => {
	it("rejects an interaction from a user other than the menu's owner", async () => {
		const interaction = buttonInteraction("close", OwnerId);
		// Simulate a different user clicking the owner's menu by overriding the member.
		const foreignInteraction = {
			...interaction,
			member: {
				...interaction.member,
				user: { ...interaction.member!.user, id: OtherUserId },
			},
		};

		const result = await runner.run(foreignInteraction as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				content:
					"Only the administrator who opened this setup menu can use it.",
			},
		});
	});
});

describe("setup interaction handler: close", () => {
	it("replaces the menu with the closed state", async () => {
		const interaction = buttonInteraction("close");

		const result = await runner.run(interaction as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.UpdateMessage,
		});
		expect(JSON.stringify(result.json())).toContain("Setup closed");
	});
});

describe("setup interaction handler: navigate", () => {
	it("renders the overview page", async () => {
		prismaMock.guildSubscription.count.mockResolvedValue(3);
		const interaction = selectInteraction("navigate", ["overview"]);

		const result = await runner.run(interaction as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.UpdateMessage,
		});
		expect(JSON.stringify(result.json())).toContain(
			"Current notifications:** 3",
		);
	});

	it("renders a select on the Manage page when subscriptions exist", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([
			buildSubscription(),
		]);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);
		const interaction = selectInteraction("navigate", ["manage"]);

		const result = await runner.run(interaction as never);

		const serialized = JSON.stringify(result.json());
		expect(serialized).toContain(buildSetupCustomId(OwnerId, "manage:select"));
		expect(serialized).toContain(StreamerDisplayName);
	});

	it("renders a select on the Test page when subscriptions exist", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([
			buildSubscription(),
		]);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);
		const interaction = selectInteraction("navigate", ["test"]);

		const result = await runner.run(interaction as never);

		const serialized = JSON.stringify(result.json());
		expect(serialized).toContain(buildSetupCustomId(OwnerId, "test:select"));
		expect(serialized).toContain(StreamerDisplayName);
	});

	it("reports an error for an unknown page value", async () => {
		const interaction = selectInteraction("navigate", ["nonexistent"]);

		const result = await runner.run(interaction as never);

		expect(JSON.stringify(result.json())).toContain(
			"That setup section is not available.",
		);
	});
});

describe("setup interaction handler: add:open", () => {
	it("shows the add modal", async () => {
		const interaction = buttonInteraction("add:open");

		const result = await runner.run(interaction as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.Modal,
		});
		expect(JSON.stringify(result.json())).toContain(
			buildSetupCustomId(OwnerId, "add:submit"),
		);
	});
});

describe("setup interaction handler: add:submit", () => {
	it("adds a subscription and shows a success notice", async () => {
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);
		prismaMock.twitchSubscription.findFirst.mockResolvedValue(null);
		prismaMock.guildSubscription.findMany.mockResolvedValue([]);
		vi.mocked(addEventSubscription).mockResolvedValue({
			id: String(SubscriptionId),
		} as never);
		prismaMock.twitchSubscription.create.mockResolvedValue({
			id: SubscriptionId,
		});
		prismaMock.guildSubscription.create.mockResolvedValue({});

		const interaction = modalInteraction([
			{ custom_id: "streamer", value: StreamerDisplayName },
			{ custom_id: "channel", values: [ChannelId] },
			{ custom_id: "type", values: [TwitchSubscriptionType.StreamOnline] },
			{ custom_id: "message", value: "" },
		]);

		const result = await runner.run(interaction as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.UpdateMessage,
		});
		expect(JSON.stringify(result.json())).toContain(
			`Success! Whenever ${StreamerDisplayName} goes live`,
		);
	});

	it("shows a validation notice when the offline type has no message", async () => {
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);

		const interaction = modalInteraction([
			{ custom_id: "streamer", value: StreamerDisplayName },
			{ custom_id: "channel", values: [ChannelId] },
			{ custom_id: "type", values: [TwitchSubscriptionType.StreamOffline] },
			{ custom_id: "message", value: "" },
		]);

		const result = await runner.run(interaction as never);

		expect(JSON.stringify(result.json())).toContain(
			"it is required to provide a message when making an offline subscription",
		);
	});

	it("shows the invalid notice when the modal is missing required fields", async () => {
		const interaction = modalInteraction([
			{ custom_id: "streamer", value: "" },
			{ custom_id: "type", values: [TwitchSubscriptionType.StreamOnline] },
			{ custom_id: "message", value: "" },
		]);

		const result = await runner.run(interaction as never);

		expect(JSON.stringify(result.json())).toContain(
			"This setup menu is invalid. Run",
		);
	});

	it("rejects a modal submission from a non-owner", async () => {
		const interaction = modalInteraction(
			[{ custom_id: "streamer", value: StreamerDisplayName }],
			OwnerId,
		);
		const foreignInteraction = {
			...interaction,
			member: {
				...interaction.member,
				user: { ...interaction.member!.user, id: OtherUserId },
			},
		};

		const result = await runner.run(foreignInteraction as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				content:
					"Only the administrator who opened this setup menu can use it.",
			},
		});
	});
});

describe("setup interaction handler: manage:select", () => {
	it("removes the matched subscriptions and shows a success notice", async () => {
		const subscription = buildSubscription();
		prismaMock.guildSubscription.findMany.mockResolvedValue([subscription]);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);
		prismaMock.guildSubscription.delete.mockResolvedValue({});
		prismaMock.twitchSubscription.findFirst.mockResolvedValue({
			guildSubscription: [],
		});
		prismaMock.twitchSubscription.delete.mockResolvedValue({});
		vi.mocked(removeEventSubscription).mockResolvedValue(undefined as never);

		const key = buildSubscriptionKey(
			subscription.channelId,
			subscription.twitchSubscription.id,
		);
		const interaction = selectInteraction("manage:select", [key]);

		const result = await runner.run(interaction as never);

		expect(prismaMock.guildSubscription.delete).toHaveBeenCalledOnce();
		expect(JSON.stringify(result.json())).toContain("Removed 1 notification.");
	});

	it("removes nothing and reports a zero-count success when nothing matches", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([
			buildSubscription(),
		]);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);

		const interaction = selectInteraction("manage:select", [
			buildSubscriptionKey(999n, 999n),
		]);

		const result = await runner.run(interaction as never);

		expect(prismaMock.guildSubscription.delete).not.toHaveBeenCalled();
		expect(JSON.stringify(result.json())).toContain("Removed 0 notifications.");
	});
});

describe("setup interaction handler: manage:reset", () => {
	it("opens the confirmation step", async () => {
		const interaction = buttonInteraction("manage:reset:open");

		const result = await runner.run(interaction as never);

		expect(JSON.stringify(result.json())).toContain(
			buildSetupCustomId(OwnerId, "manage:reset:confirm"),
		);
	});

	it("resets every subscription once confirmed", async () => {
		const subscription = buildSubscription();
		prismaMock.guildSubscription.findMany.mockResolvedValue([subscription]);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);
		prismaMock.guildSubscription.delete.mockResolvedValue({});
		prismaMock.twitchSubscription.findFirst.mockResolvedValue({
			guildSubscription: [],
		});
		prismaMock.twitchSubscription.delete.mockResolvedValue({});
		vi.mocked(removeEventSubscription).mockResolvedValue(undefined as never);

		const interaction = buttonInteraction("manage:reset:confirm");

		const result = await runner.run(interaction as never);

		expect(prismaMock.guildSubscription.delete).toHaveBeenCalledOnce();
		expect(JSON.stringify(result.json())).toContain(
			"has been removed from this server",
		);
	});
});

describe("setup interaction handler: test:select", () => {
	beforeEach(() => {
		grantChannelPermissions(
			PermissionFlagsBits.ViewChannel |
				PermissionFlagsBits.SendMessages |
				PermissionFlagsBits.EmbedLinks,
		);
	});

	it("sends the preview notification and reports success", async () => {
		const subscription = buildSubscription();
		prismaMock.guildSubscription.findMany.mockResolvedValue([subscription]);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [
					{
						id: StreamerId,
						display_name: StreamerDisplayName,
						login: "coolstreamer",
					},
				],
			}) as never,
		);
		vi.mocked(fetchStream).mockResolvedValue(null as never);

		const key = buildSubscriptionKey(
			subscription.channelId,
			subscription.twitchSubscription.id,
		);
		const interaction = selectInteraction("test:select", [key]);

		const result = await runner.run(interaction as never);

		expect(apiMock.channels.createMessage).toHaveBeenCalledOnce();
		expect(JSON.stringify(result.json())).toContain("Sent! Check");
	});

	it("reports the streamer as not found when the selection resolves but Twitch has no match", async () => {
		const subscription = buildSubscription();
		prismaMock.guildSubscription.findMany.mockResolvedValue([subscription]);
		vi.mocked(fetchUsers).mockResolvedValue(ok({ data: [] }) as never);

		const key = buildSubscriptionKey(
			subscription.channelId,
			subscription.twitchSubscription.id,
		);
		const interaction = selectInteraction("test:select", [key]);

		const result = await runner.run(interaction as never);

		expect(apiMock.channels.createMessage).not.toHaveBeenCalled();
		expect(JSON.stringify(result.json())).toContain(
			"Sorry, I could not find the streamer",
		);
	});

	it("reports the section unavailable notice when the selected key no longer matches a subscription", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([]);

		const interaction = selectInteraction("test:select", [
			buildSubscriptionKey(999n, 999n),
		]);

		const result = await runner.run(interaction as never);

		expect(apiMock.channels.createMessage).not.toHaveBeenCalled();
		expect(JSON.stringify(result.json())).toContain(
			"That setup section is not available.",
		);
	});
});

describe("setup interaction handler: unhandled component types", () => {
	it("replies with actionUnavailable for a modal submit action it does not recognise", async () => {
		const interaction = {
			...ModalSubmitInteractionData,
			data: {
				...ModalSubmitInteractionData.data,
				custom_id: buildSetupCustomId(OwnerId, "close"),
			},
		};

		const result = await runner.run(interaction as never);

		expect(JSON.stringify(result.json())).toContain(
			"This setup action is no longer available.",
		);
	});

	it("replies with an invalid-menu error when the custom_id is missing its segments", async () => {
		const interaction = {
			...MessageComponentButtonInteractionData,
			data: {
				...MessageComponentButtonInteractionData.data,
				custom_id: SetupInteractionHandlerName,
			},
		};

		const result = await runner.run(interaction as never);

		expect(JSON.stringify(result.json())).toContain(
			"This setup menu is invalid.",
		);
	});
});

describe("setup command chatInputRun (overview, unchanged)", () => {
	function buildChatInputInteraction() {
		return {
			...ChatInputApplicationCommandInteractionData,
			data: {
				id: "0",
				name: "setup",
				type: ApplicationCommandType.ChatInput,
				options: [],
			},
		};
	}

	it("opens the overview page as an ephemeral menu", async () => {
		prismaMock.guildSubscription.count.mockResolvedValue(2);

		const result = await runner.run(buildChatInputInteraction() as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.ChannelMessageWithSource,
		});
		const serialized = JSON.stringify(result.json());
		expect(serialized).toContain("Current notifications:** 2");
		expect(serialized).toContain(buildSetupCustomId(OwnerId, "navigate"));
	});
});
