import type { GuildSubscriptionWithTwitch } from "#twitch/subscriptions";
import { TwitchSubscriptionType } from "#generated/prisma";
import { SocialProviders } from "#social/registry";
import {
	buildSettingsCustomId,
	buildSubscriptionKey,
	SettingsInteractionHandlerName,
} from "#utils/settingsMenu";
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
	MessageFlags,
	PermissionFlagsBits,
} from "discord-api-types/v10";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { UserCommand } from "../../src/commands/subscriptions/settings.ts";
import { UserInteractionHandler } from "../../src/interaction-handlers/settings.ts";

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

const publicFetchMock = vi.hoisted(() => vi.fn());
vi.mock("#social/publicFetch", () => ({ fetchPublicUrl: publicFetchMock }));
afterEach(() => vi.restoreAllMocks());

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
	guildSocialSubscription: {
		findFirst: vi.fn(),
		create: vi.fn(),
		count: vi.fn(),
		findMany: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
	},
	socialSource: { deleteMany: vi.fn() },
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
	prismaMock.guildSocialSubscription.findFirst.mockResolvedValue(null);
	prismaMock.guildSocialSubscription.create.mockResolvedValue({});
	prismaMock.guildSocialSubscription.count.mockResolvedValue(0);
	prismaMock.guildSocialSubscription.findMany.mockResolvedValue([]);
	vi.mocked(areTwitchEventSubCredentialsSet).mockReturnValue(true);
	container.prisma = prismaMock as never;
	prismaMock.guildSubscription.findMany.mockResolvedValue([]);
	prismaMock.guildSubscription.count.mockResolvedValue(0);
	// The command and the "navigate" action now defer before loading data (see the "expiry"
	// fixes), so their visible response comes from editing the deferred message via REST, not
	// from the initial HTTP response body.
	vi.spyOn(container.rest, "patch").mockResolvedValue({
		id: "1",
		content: "mocked",
	} as never);

	// The handler is looked up by piece `name`, not by a decorator registry, so it must be
	// constructed with the exact name `buildSettingsCustomId` encodes in every custom_id.
	const handler = new UserInteractionHandler({
		name: SettingsInteractionHandlerName,
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

// The interaction handler re-checks Manage Server on every privileged action (a still-open menu
// must not outlive a permission revoked after `/settings` was opened), so every fixture below grants
// it by default; `rejects a member who lost Manage Server after opening the menu` overrides it.
const ManagerMember = {
	...MessageComponentButtonInteractionData.member,
	permissions: String(PermissionFlagsBits.ManageGuild),
};

/** Reads the body of the deferred response's follow-up PATCH (see the `beforeEach` REST spy). */
function patchedBody(): { content?: string; components?: unknown[] } {
	const [, body] = vi.mocked(container.rest.patch).mock.calls[0]!;
	return (body as { body: { content?: string; components?: unknown[] } }).body;
}

function buttonInteraction(action: string, userId = OwnerId) {
	return {
		...MessageComponentButtonInteractionData,
		member: ManagerMember,
		data: {
			...MessageComponentButtonInteractionData.data,
			custom_id: buildSettingsCustomId(userId, action),
		},
	};
}

function selectInteraction(action: string, values: string[], userId = OwnerId) {
	return {
		...MessageComponentStringSelectInteractionData,
		member: ManagerMember,
		data: {
			...MessageComponentStringSelectInteractionData.data,
			custom_id: buildSettingsCustomId(userId, action),
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
		member: ManagerMember,
		data: {
			...ModalSubmitInteractionData.data,
			custom_id: buildSettingsCustomId(userId, "add:submit"),
			components: fields.map((field) => ({
				type: ComponentType.Label,
				component: field,
			})),
		},
	};
}

describe("settings interaction handler: owner check", () => {
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
				content: "Only the member who opened this settings menu can use it.",
			},
		});
	});

	it("accepts a member who only holds Administrator", async () => {
		const interaction = buttonInteraction("close", OwnerId);
		const adminInteraction = {
			...interaction,
			member: {
				...interaction.member,
				permissions: String(PermissionFlagsBits.Administrator),
			},
		};

		const result = await runner.run(adminInteraction as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.UpdateMessage,
		});
	});

	it("rejects a member who lost Manage Server after opening the menu", async () => {
		const interaction = buttonInteraction("close", OwnerId);
		const nonAdminInteraction = {
			...interaction,
			member: { ...interaction.member, permissions: "0" },
		};

		const result = await runner.run(nonAdminInteraction as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				content:
					"You no longer have the Manage Server permission in this server. Run `/settings` again once it's restored.",
			},
		});
	});
});

describe("settings interaction handler: close", () => {
	it("replaces the menu with the closed state", async () => {
		const interaction = buttonInteraction("close");

		const result = await runner.run(interaction as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.UpdateMessage,
		});
		expect(JSON.stringify(result.json())).toContain("Settings closed");
	});
});

describe("settings interaction handler: navigate", () => {
	it("renders the overview page", async () => {
		prismaMock.guildSubscription.count.mockResolvedValue(3);
		const interaction = selectInteraction("navigate", ["overview"]);

		const result = await runner.run(interaction as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.DeferredMessageUpdate,
		});
		expect(JSON.stringify(patchedBody())).toContain(
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

		await runner.run(interaction as never);

		const serialized = JSON.stringify(patchedBody());
		expect(serialized).toContain(
			buildSettingsCustomId(OwnerId, "manage:select"),
		);
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

		await runner.run(interaction as never);

		const serialized = JSON.stringify(patchedBody());
		expect(serialized).toContain(buildSettingsCustomId(OwnerId, "test:select"));
		expect(serialized).toContain(StreamerDisplayName);
	});

	it("reports an error for an unknown page value", async () => {
		const interaction = selectInteraction("navigate", ["nonexistent"]);

		const result = await runner.run(interaction as never);

		expect(JSON.stringify(result.json())).toContain(
			"That settings section is not available.",
		);
	});
});

describe("settings interaction handler: add:open", () => {
	it("shows the add modal", async () => {
		const interaction = buttonInteraction("add:open");

		const result = await runner.run(interaction as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.Modal,
		});
		expect(JSON.stringify(result.json())).toContain(
			buildSettingsCustomId(OwnerId, "add:submit"),
		);
	});
});

describe("settings interaction handler: add:submit", () => {
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
			"This settings menu is invalid. Run",
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
				content: "Only the member who opened this settings menu can use it.",
			},
		});
	});
});

describe("settings interaction handler: manage:select", () => {
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

describe("settings interaction handler: manage:reset", () => {
	it("opens the confirmation step", async () => {
		const interaction = buttonInteraction("manage:reset:open");

		const result = await runner.run(interaction as never);

		expect(JSON.stringify(result.json())).toContain(
			buildSettingsCustomId(OwnerId, "manage:reset:confirm"),
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

describe("settings interaction handler: test:select", () => {
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
			"That settings section is not available.",
		);
	});
});

describe("settings interaction handler: unhandled component types", () => {
	it("replies with actionUnavailable for a modal submit action it does not recognise", async () => {
		const interaction = {
			...ModalSubmitInteractionData,
			member: ManagerMember,
			data: {
				...ModalSubmitInteractionData.data,
				custom_id: buildSettingsCustomId(OwnerId, "close"),
			},
		};

		const result = await runner.run(interaction as never);

		expect(JSON.stringify(result.json())).toContain(
			"This settings action is no longer available.",
		);
	});

	it("replies with an invalid-menu error when the custom_id is missing its segments", async () => {
		const interaction = {
			...MessageComponentButtonInteractionData,
			data: {
				...MessageComponentButtonInteractionData.data,
				custom_id: SettingsInteractionHandlerName,
			},
		};

		const result = await runner.run(interaction as never);

		expect(JSON.stringify(result.json())).toContain(
			"This settings menu is invalid.",
		);
	});
});

describe("settings command chatInputRun (overview, unchanged)", () => {
	function buildChatInputInteraction() {
		return {
			...ChatInputApplicationCommandInteractionData,
			data: {
				id: "0",
				name: "settings",
				type: ApplicationCommandType.ChatInput,
				options: [],
			},
		};
	}

	it("opens the overview page as an ephemeral menu", async () => {
		prismaMock.guildSubscription.count.mockResolvedValue(2);

		const result = await runner.run(buildChatInputInteraction() as never);

		expect(result.json()).toMatchObject({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		});
		const serialized = JSON.stringify(patchedBody());
		expect(serialized).toContain("Current notifications:** 2");
		expect(serialized).toContain(buildSettingsCustomId(OwnerId, "navigate"));
	});
});

describe("settings social providers", () => {
	const sourceId = 42n;
	function socialSubscription(channelId = BigInt(ChannelId), id = sourceId) {
		return {
			guildId: BigInt(GuildId),
			channelId,
			sourceId: id,
			message: "News",
			filters: {},
			deliveryError: null,
			source: {
				id,
				provider: "Rss",
				target: "https://example.org/feed",
				displayName: "Example feed",
				lastFailure: null,
			},
		};
	}
	it("opens provider subscriptions from the module menu", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			socialSubscription(),
		]);
		await runner.run(selectInteraction("navigate", ["social:Rss"]) as never);
		expect(JSON.stringify(patchedBody())).toContain("Example feed");
		expect(JSON.stringify(patchedBody())).toContain("Subscriptions: 1");
	});
	it("shows confirmation without deleting a subscription", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			socialSubscription(),
		]);
		await runner.run(
			buttonInteraction(`social:confirm:Rss:${ChannelId}:42`) as never,
		);
		expect(prismaMock.guildSocialSubscription.delete).not.toHaveBeenCalled();
		expect(JSON.stringify(patchedBody())).toContain("Confirm removal");
	});
	it("removes only the selected subscription in the current guild", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			socialSubscription(),
		]);
		prismaMock.guildSocialSubscription.delete.mockResolvedValue({});
		prismaMock.socialSource.deleteMany.mockResolvedValue({ count: 0 });
		await runner.run(
			buttonInteraction(`social:remove:Rss:${ChannelId}:42`) as never,
		);
		expect(prismaMock.guildSocialSubscription.delete).toHaveBeenCalledWith({
			where: {
				guildId_channelId_sourceId: {
					guildId: BigInt(GuildId),
					channelId: BigInt(ChannelId),
					sourceId,
				},
			},
			select: null,
		});
	});
	it("does not mutate a subscription absent from the current guild", async () => {
		await runner.run(
			buttonInteraction(`social:remove:Rss:${ChannelId}:42`) as never,
		);
		expect(prismaMock.guildSocialSubscription.delete).not.toHaveBeenCalled();
	});
	it("saves a message without changing the subscription filters", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			socialSubscription(),
		]);
		prismaMock.guildSocialSubscription.update.mockResolvedValue({});
		const interaction = modalInteraction([
			{ custom_id: "message", value: "Updated news" },
		]);
		interaction.data.custom_id = buildSettingsCustomId(
			OwnerId,
			`social:save:Rss:${ChannelId}:42`,
		);
		await runner.run(interaction as never);
		expect(prismaMock.guildSocialSubscription.update).toHaveBeenCalledWith({
			where: {
				guildId_channelId_sourceId: {
					guildId: BigInt(GuildId),
					channelId: BigInt(ChannelId),
					sourceId,
				},
			},
			data: { message: "Updated news" },
		});
		expect(JSON.stringify(patchedBody())).toContain("Message saved.");
	});
	it("paginates subscriptions beyond Discord's select limit", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue(
			Array.from({ length: 26 }, (_, index) =>
				socialSubscription(BigInt(ChannelId), BigInt(index + 1)),
			),
		);
		await runner.run(buttonInteraction("social:page:Rss:1") as never);
		const body = JSON.stringify(patchedBody());
		expect(body).toContain(`${ChannelId}:26`);
		expect(body).not.toContain(`"value":"${ChannelId}:1"`);
		expect(body).toContain("2 / 2");
	});
	it("reports database failure instead of presenting an empty provider as healthy", async () => {
		prismaMock.guildSocialSubscription.findMany.mockRejectedValueOnce(
			new Error("Database unavailable"),
		);
		await runner.run(selectInteraction("navigate", ["social:Rss"]) as never);
		expect(JSON.stringify(patchedBody())).toContain(
			"could not read the subscriptions",
		);
		expect(prismaMock.guildSocialSubscription.delete).not.toHaveBeenCalled();
	});
	it("counts social subscriptions in the server overview", async () => {
		prismaMock.guildSocialSubscription.count.mockResolvedValue(4);
		prismaMock.guildSubscription.count.mockResolvedValue(2);
		await runner.run(selectInteraction("navigate", ["overview"]) as never);
		expect(JSON.stringify(patchedBody())).toContain(
			"Current notifications:** 6",
		);
	});
	it("rechecks Manage Server before social mutations", async () => {
		const interaction = buttonInteraction(`social:remove:Rss:${ChannelId}:42`);
		interaction.member = { ...interaction.member, permissions: "0" };
		await runner.run(interaction as never);
		expect(prismaMock.guildSocialSubscription.delete).not.toHaveBeenCalled();
		expect(prismaMock.guildSocialSubscription.findMany).not.toHaveBeenCalled();
	});
});

describe("settings generated controls", () => {
	it("opens the message editor using the button generated by a selected subscription", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			{
				guildId: BigInt(GuildId),
				channelId: BigInt(ChannelId),
				sourceId: 42n,
				message: "Existing message",
				filters: {},
				deliveryError: null,
				source: {
					id: 42n,
					provider: "Rss",
					target: "https://example.org/feed",
					displayName: "Example feed",
					lastFailure: null,
					failureCount: 0,
				},
			},
		]);
		await runner.run(
			selectInteraction("social:select:Rss:0", [`${ChannelId}:42`]) as never,
		);
		const component = patchedBody().components?.[0] as {
			components: { components?: { custom_id: string; label: string }[] }[];
		};
		const edit = component.components
			.flatMap((row) => row.components ?? [])
			.find((control) => control.label === "Edit message")!;
		expect(edit).toBeDefined();
		const result = await runner.run(
			buttonInteraction(edit.custom_id.split(".").at(-1)!) as never,
		);
		expect(result.json()).toMatchObject({
			type: InteractionResponseType.Modal,
		});
		expect(JSON.stringify(result.json())).toContain("Existing message");
	});
	it("routes the generated Twitch section buttons to their pages", async () => {
		await runner.run(selectInteraction("navigate", ["twitch"]) as never);
		const component = patchedBody().components?.[0] as {
			components: { components?: { custom_id: string; label: string }[] }[];
		};
		const add = component.components
			.flatMap((row) => row.components ?? [])
			.find((control) => control.label === "Twitch · Add")!;
		const result = await runner.run(
			buttonInteraction(add.custom_id.split(".").at(-1)!) as never,
		);
		expect(result.json()).toMatchObject({
			type: InteractionResponseType.DeferredMessageUpdate,
		});
		const lastPatch = vi.mocked(container.rest.patch).mock.calls.at(-1)![1] as {
			body: unknown;
		};
		expect(JSON.stringify(lastPatch.body)).toContain(
			"Add a Twitch notification",
		);
	});
	it("pages through Twitch subscriptions beyond the first 25", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue(
			Array.from({ length: 26 }, (_, index) =>
				buildSubscription({
					subscriptionId: BigInt(index + 1),
					twitchSubscription: {
						...buildSubscription().twitchSubscription,
						id: BigInt(index + 1),
					},
				}),
			),
		);
		vi.mocked(fetchUsers).mockResolvedValue(ok({ data: [] }) as never);
		await runner.run(buttonInteraction("manage:page:1") as never);
		const body = JSON.stringify(patchedBody());
		expect(body).toContain(`${ChannelId}:26`);
		expect(body).not.toContain(`"value":"${ChannelId}:1"`);
	});
});

describe("settings review regressions", () => {
	it("keeps the Twitch test page after choosing a notification on page two", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue(
			Array.from({ length: 26 }, (_, index) =>
				buildSubscription({
					subscriptionId: BigInt(index + 1),
					twitchSubscription: {
						...buildSubscription().twitchSubscription,
						id: BigInt(index + 1),
					},
				}),
			),
		);
		vi.mocked(fetchUsers).mockResolvedValue(ok({ data: [] }) as never);
		await runner.run(buttonInteraction("test:page:1") as never);
		const component = patchedBody().components?.[0] as {
			components: { components?: { custom_id: string }[] }[];
		};
		const select = component.components
			.flatMap((row) => row.components ?? [])
			.find((control) => control.custom_id.includes("test:select"))!;
		const result = await runner.run(
			selectInteraction(select.custom_id.split(".").at(-1)!, [
				buildSubscriptionKey(BigInt(ChannelId), 26n),
			]) as never,
		);
		expect(JSON.stringify(result.json())).toContain("2 / 2");
	});
	it("renders the actual X account limit in the settings add notice", async () => {
		const provider = SocialProviders.find((entry) => entry.name === "X")!;
		vi.spyOn(provider, "getAuthRequirements").mockReturnValue({
			variables: [],
			satisfied: true,
		});
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue(
			["first", "second"].map((target, index) => ({
				guildId: BigInt(GuildId),
				channelId: BigInt(ChannelId),
				sourceId: BigInt(index + 1),
				source: {
					id: BigInt(index + 1),
					provider: "X",
					target,
					displayName: target,
					lastFailure: null,
					failureCount: 0,
				},
			})),
		);
		const interaction = modalInteraction([
			{ custom_id: "target", value: "third" },
			{ custom_id: "channel", values: [ChannelId] },
		]);
		interaction.data.custom_id = buildSettingsCustomId(OwnerId, "social:add:X");
		await runner.run(interaction as never);
		const notice = JSON.stringify(patchedBody());
		expect(notice).toContain("maximum of 2 X accounts");
		expect(notice).not.toContain("{{maximum}}");
	});
	it("escapes a feed title in the settings success notice", async () => {
		publicFetchMock.mockResolvedValue(
			ok({
				status: 200,
				url: "https://example.com/feed",
				headers: {},
				body: "<rss><channel><title>[a](https://example.com)</title></channel></rss>",
			}),
		);
		const interaction = modalInteraction([
			{ custom_id: "target", value: "https://example.com/feed" },
			{ custom_id: "channel", values: [ChannelId] },
		]);
		interaction.data.custom_id = buildSettingsCustomId(
			OwnerId,
			"social:add:Rss",
		);
		await runner.run(interaction as never);
		const component = patchedBody().components?.[0] as {
			components: { content?: string }[];
		};
		const notice = component.components
			.map((entry) => entry.content ?? "")
			.join("\n");
		expect(notice).toContain("\\[a\\](https://example.com)");
	});
});
