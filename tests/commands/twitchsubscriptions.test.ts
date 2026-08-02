import type {
	APIApplicationCommandInteractionDataBasicOption,
	APIChatInputApplicationCommandInteraction,
	APIInteractionDataResolved,
} from "discord-api-types/v10";
import { TwitchSubscriptionType } from "#generated/prisma";
import { err, ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import {
	ApplicationCommandAutocompleteInteractionData,
	ChatInputApplicationCommandInteractionData,
	createTestHarness,
	getAndDelete,
	makeCommand,
} from "@wolfstar/http-framework-test-utils";
import {
	ApplicationCommandOptionType,
	ApplicationCommandType,
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
import { UserCommand } from "../../src/commands/twitchsubscriptions.ts";

vi.mock("@wolfstar/twitch-helpers", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@wolfstar/twitch-helpers")>();
	return {
		...actual,
		areTwitchEventSubCredentialsSet: vi.fn(),
		fetchUsers: vi.fn(),
		addEventSubscription: vi.fn(),
		removeEventSubscription: vi.fn(),
		getRequest: vi.fn(),
	};
});

const {
	areTwitchEventSubCredentialsSet,
	fetchUsers,
	addEventSubscription,
	removeEventSubscription,
	getRequest,
} = await import("@wolfstar/twitch-helpers");

const CommandName = "twitch-subscriptions";
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
	await container.stores.get("commands").insert(makeCommand(UserCommand));
});

afterAll(() => {
	getAndDelete(UserCommand);
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
					type: ApplicationCommandOptionType.Subcommand,
					name: subcommand,
					options,
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

describe("twitchsubscriptions add", () => {
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

	it("reports a Twitch failure when the EventSub credentials are missing", async () => {
		vi.mocked(areTwitchEventSubCredentialsSet).mockReturnValue(false);

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
		expect(patchedContent()).toContain(
			"I could not create the subscription on Twitch's side",
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
});

describe("twitchsubscriptions remove", () => {
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

describe("twitchsubscriptions reset", () => {
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

describe("twitchsubscriptions show", () => {
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

describe("twitchsubscriptions autocomplete", () => {
	function buildAutocompleteInteraction(query: string) {
		return {
			...ApplicationCommandAutocompleteInteractionData,
			data: {
				id: "0",
				name: CommandName,
				type: ApplicationCommandType.ChatInput,
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
