import type {
	APIApplicationCommandInteractionDataBasicOption,
	APIChatInputApplicationCommandInteraction,
	APIInteractionDataResolved,
} from "discord-api-types/v10";
import { TwitchSubscriptionType } from "#generated/prisma";
import { err, ok } from "@sapphire/result";
import {
	applicationCommandRegistry,
	container,
} from "@wolfstar/http-framework";
import {
	ApplicationCommandAutocompleteInteractionData,
	ChatInputApplicationCommandInteractionData,
	createTestHarness,
	getAndDelete,
	makeCommand,
} from "@wolfstar/http-framework-test-utils";
import {
	clearSubcommandRegistries,
	wireParentSubcommands,
} from "@wolfstar/plugin-subcommands-advanced";
import {
	ApplicationCommandOptionType,
	ApplicationCommandType,
	PermissionFlagsBits,
} from "discord-api-types/v10";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { UserCommand as ParentCommand } from "../../src/commands/subscriptions/parent.ts";
import { UserCommand as AddCommand } from "../../src/commands/subscriptions/twitch/add.ts";
import { UserCommand as RemoveCommand } from "../../src/commands/subscriptions/twitch/remove.ts";
import { UserCommand as ResetCommand } from "../../src/commands/subscriptions/twitch/reset.ts";
import { UserCommand as ShowCommand } from "../../src/commands/subscriptions/twitch/show.ts";
import { UserCommand as TestCommand } from "../../src/commands/subscriptions/twitch/test.ts";

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
	getRequest,
} = await import("@wolfstar/twitch-helpers");

const CommandName = "subscriptions";
const GroupName = "twitch";
const StreamerId = "123456789";
const StreamerDisplayName = "CoolStreamer";
const ChannelId = "800000000000000001";
const SubscriptionId = 900n;

const prismaMock = {
	twitchSubscription: {
		findFirst: vi.fn(),
		create: vi.fn(),
		delete: vi.fn(),
	},
	guildSubscription: {
		findMany: vi.fn(),
		create: vi.fn(),
		delete: vi.fn(),
	},
};

const { runner } = createTestHarness({
	discordPublicKey: "test-discord-public-key",
	discordToken: "test.discord.token",
});

beforeAll(async () => {
	// Constructing the children is what registers them with the plugin; they are deliberately not
	// inserted into the store, both because `makeCommand` names every piece the same and because the
	// parent's router is what dispatches to them.
	for (const Child of [
		AddCommand,
		RemoveCommand,
		ResetCommand,
		ShowCommand,
		TestCommand,
	]) {
		makeCommand(Child);
	}

	const parent = makeCommand(ParentCommand);
	wireParentSubcommands(parent);
	await container.stores.get("commands").insert(parent);
});

afterAll(() => {
	getAndDelete(ParentCommand);
	clearSubcommandRegistries();
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(areTwitchEventSubCredentialsSet).mockReturnValue(true);
	container.prisma = prismaMock as never;
	vi.spyOn(container.rest, "patch").mockResolvedValue({
		id: "1",
		content: "mocked",
	} as never);
});

function buildInteraction(
	subcommand: string,
	options: APIApplicationCommandInteractionDataBasicOption[],
	resolved: APIInteractionDataResolved = {},
): APIChatInputApplicationCommandInteraction {
	return {
		...ChatInputApplicationCommandInteractionData,
		data: {
			id: "0",
			name: CommandName,
			type: ApplicationCommandType.ChatInput,
			options: [
				{
					type: ApplicationCommandOptionType.SubcommandGroup,
					name: GroupName,
					options: [
						{
							type: ApplicationCommandOptionType.Subcommand,
							name: subcommand,
							options,
						},
					],
				},
			],
			resolved,
		},
	} as APIChatInputApplicationCommandInteraction;
}

function streamerOption(
	value: string,
): APIApplicationCommandInteractionDataBasicOption {
	return { type: ApplicationCommandOptionType.String, name: "streamer", value };
}

function channelOption(
	value: string,
): APIApplicationCommandInteractionDataBasicOption {
	return { type: ApplicationCommandOptionType.Channel, name: "channel", value };
}

function typeOption(
	value: string,
): APIApplicationCommandInteractionDataBasicOption {
	return { type: ApplicationCommandOptionType.String, name: "type", value };
}

function channelResolved(): APIInteractionDataResolved {
	return {
		channels: {
			[ChannelId]: {
				id: ChannelId,
				name: "general",
				type: 0,
			},
		},
	} as APIInteractionDataResolved;
}

function patchedBody(): { content?: string; embeds?: { title: string }[] } {
	const [, body] = vi.mocked(container.rest.patch).mock.calls[0]!;
	return (
		body as {
			body: { content?: string; embeds?: { title: string }[] };
		}
	).body;
}

function patchedContent(): string {
	return patchedBody().content!;
}

describe("subscriptions twitch add", () => {
	it("subscribes a new streamer and edits the deferred reply with a success message", async () => {
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

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		const result = await runner.run(interaction);

		expect(result).toHaveStatus(200);
		expect(result.json()).toMatchObject({ type: 5 });
		expect(container.rest.patch).toHaveBeenCalledOnce();
		expect(patchedContent()).toContain(
			`Success! Whenever ${StreamerDisplayName} goes live`,
		);
	});

	it("reports the streamer as not found when Twitch returns no match", async () => {
		vi.mocked(fetchUsers).mockResolvedValue(ok({ data: [] }) as never);

		const interaction = buildInteraction(
			"add",
			[
				streamerOption("unknown"),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(patchedContent()).toContain("Sorry, I could not find the streamer");
	});

	it("requires a message when subscribing to offline notifications", async () => {
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOffline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(patchedContent()).toContain(
			"it is required to provide a message when making an offline subscription",
		);
	});

	it("rejects a duplicate subscription for the same channel and status", async () => {
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);
		prismaMock.guildSubscription.findMany.mockResolvedValue([
			{
				channelId: BigInt(ChannelId),
				twitchSubscription: {
					streamerId: StreamerId,
					subscriptionType: TwitchSubscriptionType.StreamOnline,
				},
			},
		]);

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(patchedContent()).toContain(
			"You're already subscribed to that streamer",
		);
	});

	it("reports a Twitch failure when a new subscription needs absent EventSub credentials", async () => {
		vi.mocked(areTwitchEventSubCredentialsSet).mockReturnValue(false);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);
		prismaMock.twitchSubscription.findFirst.mockResolvedValue(null);
		prismaMock.guildSubscription.findMany.mockResolvedValue([]);

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(addEventSubscription).not.toHaveBeenCalled();
		expect(prismaMock.guildSubscription.create).not.toHaveBeenCalled();
		expect(patchedContent()).toContain(
			"I could not create the subscription on Twitch's side",
		);
	});

	it("associates an existing shared subscription without EventSub credentials", async () => {
		// This branch only connects a `TwitchSubscription` another guild already created, so it must
		// not be gated behind the EventSub variables.
		vi.mocked(areTwitchEventSubCredentialsSet).mockReturnValue(false);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);
		prismaMock.twitchSubscription.findFirst.mockResolvedValue({
			id: SubscriptionId,
		});
		prismaMock.guildSubscription.findMany.mockResolvedValue([]);
		prismaMock.guildSubscription.create.mockResolvedValue({});

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(addEventSubscription).not.toHaveBeenCalled();
		expect(prismaMock.guildSubscription.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					twitchSubscription: { connect: { id: SubscriptionId } },
				}) as unknown,
			}),
		);
		expect(patchedContent()).toContain(
			`Success! Whenever ${StreamerDisplayName} goes live`,
		);
	});

	it("reports a Twitch failure when the EventSub subscription cannot be created", async () => {
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);
		prismaMock.twitchSubscription.findFirst.mockResolvedValue(null);
		prismaMock.guildSubscription.findMany.mockResolvedValue([]);
		vi.mocked(addEventSubscription).mockRejectedValue(new Error("boom"));

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(prismaMock.guildSubscription.create).not.toHaveBeenCalled();
		expect(patchedContent()).toContain(
			"I could not create the subscription on Twitch's side",
		);
	});

	it("reverts the EventSub subscription when the database write fails", async () => {
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
		prismaMock.guildSubscription.create.mockRejectedValue(new Error("boom"));
		vi.mocked(removeEventSubscription).mockResolvedValue(undefined as never);

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(removeEventSubscription).toHaveBeenCalledWith(
			String(SubscriptionId),
		);
		expect(patchedContent()).toContain("I could not save the subscription");
	});

	it("does not persist the subscription when Twitch no longer lists it", async () => {
		// A rejected delete does not prove Twitch kept the subscription. Persisting a row for one that is
		// already gone would make a later add connect to it and silently never deliver.
		const fatal = vi.spyOn(container.logger, "fatal").mockImplementation(() => {
			// noop
		});
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
		prismaMock.guildSubscription.create.mockRejectedValue(new Error("boom"));
		vi.mocked(removeEventSubscription).mockRejectedValue(new Error("offline"));
		vi.mocked(getRequest).mockResolvedValue(ok({ data: [] }) as never);
		prismaMock.twitchSubscription.create.mockResolvedValue({});

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(prismaMock.twitchSubscription.create).not.toHaveBeenCalled();
		expect(fatal).toHaveBeenCalledWith(
			expect.stringContaining(
				`Could not confirm the stream.online EventSub subscription "${SubscriptionId}"`,
			),
			expect.any(Error),
		);
		expect(patchedContent()).toContain("I could not save the subscription");
		fatal.mockRestore();
	});

	it("does not persist the subscription when the confirmation lookup fails", async () => {
		const fatal = vi.spyOn(container.logger, "fatal").mockImplementation(() => {
			// noop
		});
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
		prismaMock.guildSubscription.create.mockRejectedValue(new Error("boom"));
		vi.mocked(removeEventSubscription).mockRejectedValue(new Error("offline"));
		vi.mocked(getRequest).mockRejectedValue(new Error("offline"));
		prismaMock.twitchSubscription.create.mockResolvedValue({});

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(prismaMock.twitchSubscription.create).not.toHaveBeenCalled();
		expect(fatal).toHaveBeenCalledOnce();
		expect(patchedContent()).toContain("I could not save the subscription");
		fatal.mockRestore();
	});

	it("persists the shared subscription when the EventSub rollback also fails", async () => {
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
		prismaMock.guildSubscription.create.mockRejectedValue(new Error("boom"));
		vi.mocked(removeEventSubscription).mockRejectedValue(new Error("offline"));
		vi.mocked(getRequest).mockResolvedValue(
			ok({ data: [{ id: String(SubscriptionId) }] }) as never,
		);
		prismaMock.twitchSubscription.create.mockResolvedValue({});

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(removeEventSubscription).toHaveBeenCalledWith(
			String(SubscriptionId),
		);
		// Scoped to the broadcaster and event type so the single page Twitch returns is complete.
		expect(getRequest).toHaveBeenCalledWith(
			`eventsub/subscriptions?user_id=${StreamerId}&type=stream.online`,
		);
		expect(prismaMock.twitchSubscription.create).toHaveBeenCalledWith({
			data: {
				streamerId: StreamerId,
				subscriptionId: String(SubscriptionId),
				subscriptionType: TwitchSubscriptionType.StreamOnline,
			},
			select: null,
		});
		expect(patchedContent()).toContain("I could not save the subscription");
	});

	it("persists the shared subscription when Twitch lists it on a later page", async () => {
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
		prismaMock.guildSubscription.create.mockRejectedValue(new Error("boom"));
		vi.mocked(removeEventSubscription).mockRejectedValue(new Error("offline"));
		vi.mocked(getRequest)
			.mockResolvedValueOnce(
				ok({
					data: [{ id: "another-subscription" }],
					pagination: { cursor: "next-page" },
				}) as never,
			)
			.mockResolvedValueOnce(
				ok({ data: [{ id: String(SubscriptionId) }] }) as never,
			);
		prismaMock.twitchSubscription.create.mockResolvedValue({});

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(getRequest).toHaveBeenNthCalledWith(
			1,
			`eventsub/subscriptions?user_id=${StreamerId}&type=stream.online`,
		);
		expect(getRequest).toHaveBeenNthCalledWith(
			2,
			`eventsub/subscriptions?user_id=${StreamerId}&type=stream.online&after=next-page`,
		);
		expect(prismaMock.twitchSubscription.create).toHaveBeenCalledWith({
			data: {
				streamerId: StreamerId,
				subscriptionId: String(SubscriptionId),
				subscriptionType: TwitchSubscriptionType.StreamOnline,
			},
			select: null,
		});
		expect(patchedContent()).toContain("I could not save the subscription");
	});

	it("logs the orphaned EventSub subscription when the revert and recovery both fail", async () => {
		const fatal = vi.spyOn(container.logger, "fatal").mockImplementation(() => {
			// noop
		});
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
		prismaMock.guildSubscription.create.mockRejectedValue(new Error("boom"));
		vi.mocked(removeEventSubscription).mockRejectedValue(new Error("offline"));
		vi.mocked(getRequest).mockResolvedValue(
			ok({ data: [{ id: String(SubscriptionId) }] }) as never,
		);
		prismaMock.twitchSubscription.create.mockRejectedValue(
			new Error("db down"),
		);

		const interaction = buildInteraction(
			"add",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(fatal).toHaveBeenCalledWith(
			expect.stringContaining(
				`Orphaned stream.online EventSub subscription "${SubscriptionId}"`,
			),
			expect.any(Error),
			expect.any(Error),
		);
		expect(patchedContent()).toContain("I could not save the subscription");
		fatal.mockRestore();
	});
});

describe("subscriptions twitch remove", () => {
	it("removes a matching subscription", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([
			{
				channelId: BigInt(ChannelId),
				subscriptionId: SubscriptionId,
				twitchSubscription: {
					streamerId: StreamerId,
					subscriptionType: TwitchSubscriptionType.StreamOnline,
				},
			},
		]);
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

		const interaction = buildInteraction(
			"remove",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		const result = await runner.run(interaction);

		expect(result).toHaveStatus(200);
		expect(result.json()).toMatchObject({ type: 5 });
		expect(patchedContent()).toContain("I will no longer post messages to");
	});

	it("reports when the streamer has no subscriptions at all", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([]);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);

		const interaction = buildInteraction(
			"remove",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(patchedContent()).toContain(
			"because you are not subscribed to them",
		);
	});

	it("reports when the subscribed status does not match", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([
			{
				channelId: BigInt(ChannelId),
				subscriptionId: SubscriptionId,
				twitchSubscription: {
					streamerId: StreamerId,
					subscriptionType: TwitchSubscriptionType.StreamOffline,
				},
			},
		]);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);

		const interaction = buildInteraction(
			"remove",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(patchedContent()).toContain("it looks like you're not getting");
	});

	it("reports when the subscription is not posted to the provided channel", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([
			{
				channelId: BigInt("999999999999999999"),
				subscriptionId: SubscriptionId,
				twitchSubscription: {
					streamerId: StreamerId,
					subscriptionType: TwitchSubscriptionType.StreamOnline,
				},
			},
		]);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);

		const interaction = buildInteraction(
			"remove",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(patchedContent()).toContain("their subscription is not posted to");
	});

	it("reports a failure when the removal throws", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([
			{
				channelId: BigInt(ChannelId),
				subscriptionId: SubscriptionId,
				twitchSubscription: {
					streamerId: StreamerId,
					subscriptionType: TwitchSubscriptionType.StreamOnline,
				},
			},
		]);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);
		prismaMock.guildSubscription.delete.mockRejectedValue(new Error("boom"));

		const interaction = buildInteraction(
			"remove",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption("StreamOnline"),
			],
			channelResolved(),
		);

		await runner.run(interaction);

		expect(patchedContent()).toContain("I could not remove the subscription");
	});
});

describe("subscriptions twitch reset", () => {
	it("removes every subscription for the guild", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([
			{
				channelId: BigInt(ChannelId),
				subscriptionId: SubscriptionId,
				twitchSubscription: {
					streamerId: StreamerId,
					subscriptionType: TwitchSubscriptionType.StreamOnline,
				},
			},
		]);
		prismaMock.guildSubscription.delete.mockResolvedValue({});
		prismaMock.twitchSubscription.findFirst.mockResolvedValue({
			guildSubscription: [],
		});
		prismaMock.twitchSubscription.delete.mockResolvedValue({});
		vi.mocked(removeEventSubscription).mockResolvedValue(undefined as never);

		const interaction = buildInteraction("reset", []);

		await runner.run(interaction);

		expect(patchedContent()).toContain("has been removed from this server");
	});

	it("reports when there is nothing to reset", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([]);

		const interaction = buildInteraction("reset", []);

		await runner.run(interaction);

		expect(patchedContent()).toContain("not subscribed to any streamers");
	});
});

describe("subscriptions twitch show", () => {
	it("lists the guild's subscriptions", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([
			{
				channelId: BigInt(ChannelId),
				subscriptionId: SubscriptionId,
				twitchSubscription: {
					streamerId: StreamerId,
					subscriptionType: TwitchSubscriptionType.StreamOnline,
				},
			},
		]);
		vi.mocked(fetchUsers).mockResolvedValue(
			ok({
				data: [{ id: StreamerId, display_name: StreamerDisplayName }],
			}) as never,
		);

		const interaction = buildInteraction("show", []);

		await runner.run(interaction);

		expect(patchedBody()).toMatchObject({
			embeds: [{ title: "Twitch Subscriptions" }],
		});
	});

	it("reports when there are no subscriptions to show", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([]);

		const interaction = buildInteraction("show", []);

		await runner.run(interaction);

		expect(patchedContent()).toContain("not subscribed to any streamers");
	});
});

describe("subscriptions twitch autocomplete", () => {
	function buildAutocompleteInteraction(query: string) {
		return {
			...ApplicationCommandAutocompleteInteractionData,
			data: {
				id: "0",
				name: CommandName,
				type: ApplicationCommandType.ChatInput,
				options: [
					{
						type: ApplicationCommandOptionType.SubcommandGroup,
						name: GroupName,
						options: [
							{
								type: ApplicationCommandOptionType.Subcommand,
								name: "add",
								options: [
									{
										type: ApplicationCommandOptionType.String,
										name: "streamer",
										value: query,
										focused: true,
									},
								],
							},
						],
					},
				],
			},
		};
	}

	it("replies empty when the query is blank", async () => {
		const result = await runner.run(buildAutocompleteInteraction(""));

		expect(result.json()).toMatchObject({ type: 8, data: { choices: [] } });
		expect(getRequest).not.toHaveBeenCalled();
	});

	it("replies empty when the Twitch search fails", async () => {
		vi.mocked(getRequest).mockResolvedValue(err(new Error("boom")) as never);

		const result = await runner.run(buildAutocompleteInteraction("cool"));

		expect(result.json()).toMatchObject({ type: 8, data: { choices: [] } });
	});

	it("maps Twitch search results into choices", async () => {
		vi.mocked(getRequest).mockResolvedValue(
			ok({
				data: [
					{
						broadcaster_login: "coolstreamer",
						display_name: StreamerDisplayName,
						id: StreamerId,
						is_live: false,
					},
				],
			}) as never,
		);

		const result = await runner.run(buildAutocompleteInteraction("cool"));

		expect(result.json()).toMatchObject({
			type: 8,
			data: {
				choices: [{ name: StreamerDisplayName, value: "coolstreamer" }],
			},
		});
	});
});

describe("subscriptions twitch test", () => {
	const GuildId = "737141877803057244";
	const SubscriptionMessage = "Hey, we are live!";

	function grantPermissions(permissions: bigint) {
		apiMock.guilds.get.mockResolvedValue({ preferred_locale: "en-US" });
		apiMock.guilds.getChannels.mockResolvedValue([
			{ id: ChannelId, name: "general", type: 0, guild_id: GuildId },
		]);
		apiMock.users.getCurrent.mockResolvedValue({ id: "bot-id" });
		apiMock.guilds.getMember.mockResolvedValue({
			permissions: String(permissions),
		});
		apiMock.channels.createMessage.mockResolvedValue({ id: "1" });
	}

	function subscribe(
		subscriptionType: TwitchSubscriptionType,
		overrides: Record<string, unknown> = {},
	) {
		prismaMock.guildSubscription.findMany.mockResolvedValue([
			{
				guildId: BigInt(GuildId),
				channelId: BigInt(ChannelId),
				subscriptionId: SubscriptionId,
				message: SubscriptionMessage,
				twitchSubscription: {
					streamerId: StreamerId,
					subscriptionType,
				},
				...overrides,
			},
		]);
	}

	function sentBody() {
		const [, body] = apiMock.channels.createMessage.mock.calls[0]!;
		return body as {
			content?: string;
			embeds?: { title?: string; description?: string }[];
		};
	}

	function buildTestInteraction(type: string) {
		return buildInteraction(
			"test",
			[
				streamerOption(StreamerDisplayName),
				channelOption(ChannelId),
				typeOption(type),
			],
			channelResolved(),
		);
	}

	beforeEach(() => {
		grantPermissions(
			PermissionFlagsBits.ViewChannel |
				PermissionFlagsBits.SendMessages |
				PermissionFlagsBits.EmbedLinks,
		);
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
	});

	it("posts the configured online notification and confirms it", async () => {
		subscribe(TwitchSubscriptionType.StreamOnline);
		vi.mocked(fetchStream).mockResolvedValue({
			game_name: "Just Chatting",
			thumbnail_url: "https://cdn.twitch.tv/thumb-{width}x{height}.png",
			started_at: new Date("2026-08-07T12:00:00.000Z"),
			title: "A great stream",
			viewer_count: 42,
		} as never);

		await runner.run(buildTestInteraction("StreamOnline"));

		expect(apiMock.channels.createMessage).toHaveBeenCalledOnce();
		const body = sentBody();
		expect(body.content).toContain("Test notification");
		expect(body.content).toContain(SubscriptionMessage);
		expect(body.embeds?.[0]?.title).toBe("A great stream");
		expect(patchedContent()).toContain("Sent! Check");
	});

	it("still posts a preview when the streamer is not live", async () => {
		subscribe(TwitchSubscriptionType.StreamOnline);
		vi.mocked(fetchStream).mockResolvedValue(null as never);

		await runner.run(buildTestInteraction("StreamOnline"));

		expect(sentBody().embeds?.[0]?.title).toBe("Test notification");
		expect(patchedContent()).toContain("Sent! Check");
	});

	it("posts the stored message for an offline subscription", async () => {
		subscribe(TwitchSubscriptionType.StreamOffline);

		await runner.run(buildTestInteraction("StreamOffline"));

		const body = sentBody();
		expect(body.embeds).toBeUndefined();
		expect(body.content).toContain(SubscriptionMessage);
		expect(body.content).toContain("Staryl Twitch Notifications");
		expect(patchedContent()).toContain("Sent! Check");
	});

	it("reports the exact missing permission instead of failing silently", async () => {
		subscribe(TwitchSubscriptionType.StreamOnline);
		vi.mocked(fetchStream).mockResolvedValue(null as never);
		grantPermissions(
			PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
		);

		await runner.run(buildTestInteraction("StreamOnline"));

		expect(apiMock.channels.createMessage).not.toHaveBeenCalled();
		expect(patchedContent()).toContain("I cannot post in");
		expect(patchedContent()).toContain("Embed Links");
	});

	it("reports a rejected send", async () => {
		subscribe(TwitchSubscriptionType.StreamOnline);
		vi.mocked(fetchStream).mockResolvedValue(null as never);
		apiMock.channels.createMessage.mockRejectedValue(new Error("403"));

		await runner.run(buildTestInteraction("StreamOnline"));

		expect(patchedContent()).toContain("Discord rejected the message");
	});

	it("reports a channel it can no longer see", async () => {
		subscribe(TwitchSubscriptionType.StreamOnline);
		vi.mocked(fetchStream).mockResolvedValue(null as never);
		apiMock.guilds.getChannels.mockResolvedValue([]);

		await runner.run(buildTestInteraction("StreamOnline"));

		expect(patchedContent()).toContain("I can no longer see");
	});

	it("reports when the streamer is not subscribed at all", async () => {
		prismaMock.guildSubscription.findMany.mockResolvedValue([]);

		await runner.run(buildTestInteraction("StreamOnline"));

		expect(apiMock.channels.createMessage).not.toHaveBeenCalled();
		expect(patchedContent()).toContain("you cannot unsubscribe from");
	});

	it("reports when the subscribed status does not match", async () => {
		subscribe(TwitchSubscriptionType.StreamOffline);

		await runner.run(buildTestInteraction("StreamOnline"));

		expect(apiMock.channels.createMessage).not.toHaveBeenCalled();
		expect(patchedContent()).toContain("you're not getting");
	});

	it("reports when the subscription is not posted to the provided channel", async () => {
		subscribe(TwitchSubscriptionType.StreamOnline, {
			channelId: BigInt("800000000000000999"),
		});

		await runner.run(buildTestInteraction("StreamOnline"));

		expect(apiMock.channels.createMessage).not.toHaveBeenCalled();
		expect(patchedContent()).toContain("their subscription is not posted to");
	});

	it("reports an offline subscription that has no message to send", async () => {
		subscribe(TwitchSubscriptionType.StreamOffline, { message: null });

		await runner.run(buildTestInteraction("StreamOffline"));

		expect(apiMock.channels.createMessage).not.toHaveBeenCalled();
		expect(patchedContent()).toContain("has no message saved");
	});

	it("reports the streamer as not found when Twitch returns no match", async () => {
		vi.mocked(fetchUsers).mockResolvedValue(ok({ data: [] }) as never);

		await runner.run(buildTestInteraction("StreamOnline"));

		expect(apiMock.channels.createMessage).not.toHaveBeenCalled();
		expect(patchedContent()).toContain("I could not find the streamer");
	});
});

describe("subscriptions registration", () => {
	function registeredCommand() {
		return applicationCommandRegistry.get(ParentCommand)!.chatInput!.toJSON();
	}

	it("registers a single command named subscriptions", () => {
		expect(registeredCommand()).toMatchObject({
			name: CommandName,
			default_member_permissions: String(PermissionFlagsBits.Administrator),
		});
	});

	it("nests every subcommand under the twitch group", () => {
		const [group, ...rest] = registeredCommand().options!;

		expect(rest).toHaveLength(0);
		expect(group).toMatchObject({
			type: ApplicationCommandOptionType.SubcommandGroup,
			name: GroupName,
		});
		expect(
			(group as { options: { name: string }[] }).options
				.map((option) => option.name)
				.toSorted(),
		).toEqual(["add", "remove", "reset", "show", "test"]);
	});
});
