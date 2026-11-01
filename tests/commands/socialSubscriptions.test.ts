import type {
	APIApplicationCommandInteractionDataBasicOption,
	APIChatInputApplicationCommandInteraction,
	APIInteractionDataResolved,
} from "discord-api-types/v10";
import { readFileSync } from "node:fs";
import { SocialProviders } from "#social/registry";
import { MaximumSocialSubscriptionsPerGuild } from "#social/subscriptions";
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
import { UserCommand as AddCommand } from "../../src/commands/subscriptions/social/add.ts";
import { UserCommand as RemoveCommand } from "../../src/commands/subscriptions/social/remove.ts";
import { UserCommand as ResetCommand } from "../../src/commands/subscriptions/social/reset.ts";
import { UserCommand as ShowCommand } from "../../src/commands/subscriptions/social/show.ts";
import { UserCommand as TestCommand } from "../../src/commands/subscriptions/social/test.ts";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("#social/publicFetch", () => ({ fetchPublicUrl: fetchMock }));

const apiMock = vi.hoisted(() => ({
	guilds: { get: vi.fn(), getChannels: vi.fn(), getMember: vi.fn() },
	channels: { createMessage: vi.fn() },
	users: { getCurrent: vi.fn() },
}));

vi.mock("#utils/discordApi", () => ({ api: () => apiMock }));

const Rss = readFileSync(
	new URL("../fixtures/rss.xml", import.meta.url),
	"utf8",
);
const CommandName = "subscriptions";
const GroupName = "social";
const GuildId = "737141877803057244";
const ChannelId = "800000000000000001";
const FeedUrl = "https://example.com/feed.xml";
const BotRoleId = "900000000000000001";

const prismaMock = {
	guildSocialSubscription: {
		count: vi.fn(),
		create: vi.fn(),
		delete: vi.fn(),
		findFirst: vi.fn(),
		findMany: vi.fn(),
	},
	socialSource: { deleteMany: vi.fn() },
};

const { runner } = createTestHarness({
	discordPublicKey: "test-discord-public-key",
	discordToken: "test.discord.token",
});

beforeAll(async () => {
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
	container.prisma = prismaMock as never;
	vi.spyOn(container.rest, "patch").mockResolvedValue({
		id: "1",
		content: "mocked",
	} as never);

	fetchMock.mockResolvedValue(
		ok({ status: 200, url: FeedUrl, headers: {}, body: Rss }),
	);
	prismaMock.guildSocialSubscription.count.mockResolvedValue(0);
	prismaMock.guildSocialSubscription.findFirst.mockResolvedValue(null);
	prismaMock.guildSocialSubscription.findMany.mockResolvedValue([]);
	prismaMock.guildSocialSubscription.create.mockResolvedValue({});
	prismaMock.guildSocialSubscription.delete.mockResolvedValue({});
	prismaMock.socialSource.deleteMany.mockResolvedValue({ count: 1 });
});

function buildInteraction(
	subcommand: string,
	options: APIApplicationCommandInteractionDataBasicOption[] = [],
): APIChatInputApplicationCommandInteraction {
	return {
		...ChatInputApplicationCommandInteractionData,
		guild_id: GuildId,
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
			resolved: {
				channels: {
					[ChannelId]: { id: ChannelId, name: "general", type: 0 },
				},
			} as unknown as APIInteractionDataResolved,
		},
	} as APIChatInputApplicationCommandInteraction;
}

function string(name: string, value: string) {
	return { type: ApplicationCommandOptionType.String, name, value } as const;
}

const channelOption = {
	type: ApplicationCommandOptionType.Channel,
	name: "channel",
	value: ChannelId,
} as const;

function addOptions(...extra: ReturnType<typeof string>[]) {
	return [
		string("provider", "Rss"),
		string("target", FeedUrl),
		channelOption,
		...extra,
	];
}

function reply() {
	const [, body] = vi.mocked(container.rest.patch).mock.calls[0]!;
	return (
		body as { body: { content?: string; embeds?: { description: string }[] } }
	).body;
}

function makeSubscription(overrides: Record<string, unknown> = {}) {
	return {
		guildId: BigInt(GuildId),
		channelId: BigInt(ChannelId),
		sourceId: 5n,
		message: null,
		filters: {},
		seenItemIds: [],
		deliveryError: null,
		source: {
			id: 5n,
			provider: "Rss",
			target: FeedUrl,
			displayName: "Example",
			state: null,
			lastFailure: null,
			failureCount: 0,
		},
		...overrides,
	};
}

describe("subscriptions social add", () => {
	it("stores the source and counts what it lists today as already seen", async () => {
		await runner.run(buildInteraction("add", addOptions()));

		const { data } = prismaMock.guildSocialSubscription.create.mock.calls[0][0];
		expect(data.seenItemIds).toEqual([
			"https://example.com/newer",
			"older-guid",
		]);
		expect(data.source.connectOrCreate.create).toMatchObject({
			provider: "Rss",
			target: FeedUrl,
			displayName: "Example & Friends",
		});
		expect(reply().content).toContain("Example & Friends");
	});

	it("does not let a feed title restyle the confirmation", async () => {
		fetchMock.mockResolvedValue(
			ok({
				status: 200,
				url: FeedUrl,
				headers: {},
				body: "<rss><channel><title>[a](https://example.com)</title></channel></rss>",
			}),
		);

		await runner.run(buildInteraction("add", addOptions()));

		expect(reply().content).toContain("\\[a\\](https://example.com)");
	});

	it("keeps the keywords as filters", async () => {
		await runner.run(
			buildInteraction(
				"add",
				addOptions(
					string("keywords", "Rust, Go"),
					string("exclude_keywords", "spam"),
				),
			),
		);

		const { data } = prismaMock.guildSocialSubscription.create.mock.calls[0][0];
		expect(data.filters).toMatchObject({
			includeKeywords: ["rust", "go"],
			excludeKeywords: ["spam"],
		});
	});

	it("refuses a filter the provider has no data for", async () => {
		await runner.run(
			buildInteraction("add", addOptions(string("flairs", "News"))),
		);

		expect(reply().content).toContain("does not have the data");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("says so when a provider has no credentials", async () => {
		await runner.run(
			buildInteraction("add", [
				string("provider", "Reddit"),
				string("target", "typescript"),
				channelOption,
			]),
		);

		expect(reply().content).toContain("not available");
	});

	it.each([
		[
			"a page without a feed",
			ok({ status: 200, url: FeedUrl, headers: {}, body: "<html></html>" }),
			"no RSS or Atom feed",
		],
		[
			"an address on a private network",
			err({ _tag: "ForbiddenAddress" }),
			"has to be public",
		],
		["an unreachable host", err({ _tag: "Timeout" }), "could not reach"],
		[
			"a page that does not exist",
			ok({ status: 404, url: FeedUrl, headers: {}, body: "" }),
			"could not find",
		],
	])("explains %s and stores nothing", async (_, answer, message) => {
		fetchMock.mockResolvedValue(answer);

		await runner.run(buildInteraction("add", addOptions()));

		expect(reply().content).toContain(message);
		expect(prismaMock.guildSocialSubscription.create).not.toHaveBeenCalled();
	});

	it("shortens a title that would not fit the column", async () => {
		const longTitle = "x".repeat(400);
		fetchMock.mockResolvedValue(
			ok({
				status: 200,
				url: FeedUrl,
				headers: {},
				body: `<rss><channel><title>${longTitle}</title></channel></rss>`,
			}),
		);

		await runner.run(buildInteraction("add", addOptions()));

		const { data } = prismaMock.guildSocialSubscription.create.mock.calls[0][0];
		expect(
			data.source.connectOrCreate.create.displayName.length,
		).toBeLessThanOrEqual(200);
	});

	it("refuses a URL that would not fit the column", async () => {
		fetchMock.mockResolvedValue(
			ok({
				status: 200,
				url: `https://example.com/${"x".repeat(600)}`,
				headers: {},
				body: Rss,
			}),
		);

		await runner.run(buildInteraction("add", addOptions()));

		expect(prismaMock.guildSocialSubscription.create).not.toHaveBeenCalled();
	});

	it("refuses a duplicate", async () => {
		prismaMock.guildSocialSubscription.findFirst.mockResolvedValue({});

		await runner.run(buildInteraction("add", addOptions()));

		expect(reply().content).toContain("already follows");
		expect(prismaMock.guildSocialSubscription.create).not.toHaveBeenCalled();
	});

	it("refuses past the limit of the guild, before touching the network", async () => {
		prismaMock.guildSocialSubscription.count.mockResolvedValue(
			MaximumSocialSubscriptionsPerGuild,
		);

		await runner.run(buildInteraction("add", addOptions()));

		expect(reply().content).toContain("maximum");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("checks the limit again after the slow part, for adds racing each other", async () => {
		prismaMock.guildSocialSubscription.count
			.mockResolvedValueOnce(MaximumSocialSubscriptionsPerGuild - 1)
			.mockResolvedValueOnce(MaximumSocialSubscriptionsPerGuild);

		await runner.run(buildInteraction("add", addOptions()));

		expect(reply().content).toContain("maximum");
		expect(prismaMock.guildSocialSubscription.create).not.toHaveBeenCalled();
	});

	it("still answers when a provider throws", async () => {
		vi.spyOn(container.logger, "error").mockImplementation(() => undefined);
		fetchMock.mockRejectedValue(new Error("bug"));

		await runner.run(buildInteraction("add", addOptions()));

		expect(reply().content).toContain("could not reach");
	});

	it("reports a database failure", async () => {
		prismaMock.guildSocialSubscription.create.mockRejectedValue(
			new Error("down"),
		);
		vi.spyOn(container.logger, "error").mockImplementation(() => undefined);

		await runner.run(buildInteraction("add", addOptions()));

		expect(reply().content).toContain("could not save");
	});
});

describe("subscriptions social remove", () => {
	it("removes the subscription and only an orphaned source", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
		]);

		await runner.run(
			buildInteraction("remove", [string("source", "5"), channelOption]),
		);

		expect(prismaMock.guildSocialSubscription.delete).toHaveBeenCalled();
		expect(prismaMock.socialSource.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: [5n] }, subscriptions: { none: {} } },
		});
		expect(reply().content).toContain("no longer post");
	});

	it("removes a subscription whose channel no longer exists, without naming it", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription({ channelId: 123n }),
		]);

		await runner.run(buildInteraction("remove", [string("source", "5")]));

		expect(prismaMock.guildSocialSubscription.delete).toHaveBeenCalledWith({
			where: {
				guildId_channelId_sourceId: {
					guildId: BigInt(GuildId),
					channelId: 123n,
					sourceId: 5n,
				},
			},
			select: null,
		});
	});

	it("asks which channel when several follow the source", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
			makeSubscription({ channelId: 123n }),
		]);

		await runner.run(buildInteraction("remove", [string("source", "5")]));

		expect(prismaMock.guildSocialSubscription.delete).not.toHaveBeenCalled();
		expect(reply().content).toContain("Several channels");
	});

	it("reports success even when the source could not be cleaned up", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
		]);
		prismaMock.socialSource.deleteMany.mockRejectedValue(new Error("in use"));

		await runner.run(
			buildInteraction("remove", [string("source", "5"), channelOption]),
		);

		expect(reply().content).toContain("no longer post");
	});

	it.each(["6", "typed by hand"])(
		"does not remove anything for the source %j",
		async (source) => {
			prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
				makeSubscription(),
			]);

			await runner.run(
				buildInteraction("remove", [string("source", source), channelOption]),
			);

			expect(prismaMock.guildSocialSubscription.delete).not.toHaveBeenCalled();
			expect(reply().content).toContain("does not follow");
		},
	);
});

describe("subscriptions social reset", () => {
	it("removes everything the guild follows", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
			makeSubscription({ sourceId: 6n }),
		]);

		await runner.run(buildInteraction("reset"));

		expect(prismaMock.guildSocialSubscription.delete).toHaveBeenCalledTimes(2);
		expect(reply().content).toContain("2 subscriptions");
	});

	it("says so when there is nothing to remove", async () => {
		await runner.run(buildInteraction("reset"));

		expect(reply().content).toContain("does not follow any");
	});
});

describe("subscriptions social show", () => {
	it("says how each subscription is doing", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
			makeSubscription({
				source: {
					...makeSubscription().source,
					displayName: "Gone",
					lastFailure: "TargetUnavailable",
					failureCount: 4,
				},
				deliveryError: "MissingPermissions",
			}),
		]);

		await runner.run(buildInteraction("show"));

		const { description } = reply().embeds![0];
		expect(description).toContain("**Example**");
		expect(description).toContain("Working");
		expect(description).toContain("no longer public");
		expect(description).toContain("Send Messages");
	});
});

describe("subscriptions social show limits", () => {
	it("shows every subscription of a full server, within Discord's limits", async () => {
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue(
			Array.from({ length: MaximumSocialSubscriptionsPerGuild }, (_, index) =>
				makeSubscription({
					sourceId: BigInt(index),
					deliveryError: "MissingPermissions",
					source: {
						...makeSubscription().source,
						lastFailure: "AuthFailed",
						failureCount: 1,
						displayName: "*".repeat(200),
					},
				}),
			),
		);

		await runner.run(buildInteraction("show"));

		const descriptions = reply().embeds!.map(({ description }) => description);
		expect(descriptions.join("\n").match(/\(RSS or Atom feed\)/g)).toHaveLength(
			MaximumSocialSubscriptionsPerGuild,
		);
		expect(
			Math.max(...descriptions.map(({ length }) => length)),
		).toBeLessThanOrEqual(4096);
		expect(descriptions.join("").length).toBeLessThanOrEqual(5900);
	});
});

describe("subscriptions social test", () => {
	function allowPosting() {
		apiMock.guilds.get.mockResolvedValue({
			preferred_locale: "en-US",
			roles: [
				{ id: GuildId, permissions: "0" },
				{
					id: BotRoleId,
					permissions: String(
						PermissionFlagsBits.ViewChannel |
							PermissionFlagsBits.SendMessages |
							PermissionFlagsBits.EmbedLinks,
					),
				},
			],
		});
		apiMock.guilds.getChannels.mockResolvedValue([
			{ id: ChannelId, name: "general", type: 0, guild_id: GuildId },
		]);
		apiMock.users.getCurrent.mockResolvedValue({ id: "bot-id" });
		apiMock.guilds.getMember.mockResolvedValue({ roles: [BotRoleId] });
		apiMock.channels.createMessage.mockResolvedValue({ id: "1" });
	}

	it("posts the newest item under the test notice", async () => {
		allowPosting();
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
		]);

		await runner.run(
			buildInteraction("test", [string("source", "5"), channelOption]),
		);

		const [channelId, body] = apiMock.channels.createMessage.mock.calls[0]!;
		expect(channelId).toBe(ChannelId);
		expect(JSON.stringify(body)).toContain("Test notification");
		expect(JSON.stringify(body)).toContain("https://example.com/newer");
		expect(reply().content).toContain("Sent!");
	});

	it("does not preview an NSFW item in a channel not marked as NSFW", async () => {
		allowPosting();
		const item = {
			text: null,
			authorName: null,
			authorAvatarUrl: null,
			imageUrl: null,
			publishedAt: null,
		};
		vi.spyOn(SocialProviders[0], "fetchLatest").mockResolvedValueOnce(
			ok({
				_tag: "Items",
				state: null,
				items: [
					{
						...item,
						id: "1",
						url: "https://example.com/adult",
						title: "Adult",
						isNsfw: true,
					},
					{
						...item,
						id: "2",
						url: "https://example.com/safe",
						title: "Safe",
					},
				],
			}),
		);
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
		]);

		await runner.run(
			buildInteraction("test", [string("source", "5"), channelOption]),
		);

		const [, body] = apiMock.channels.createMessage.mock.calls[0]!;
		expect(JSON.stringify(body)).toContain("https://example.com/safe");
		expect(JSON.stringify(body)).not.toContain("https://example.com/adult");
	});

	it("still answers when a provider throws", async () => {
		allowPosting();
		vi.spyOn(container.logger, "error").mockImplementation(() => undefined);
		vi.spyOn(SocialProviders[0], "fetchLatest").mockRejectedValueOnce(
			new Error("bug"),
		);
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
		]);

		await runner.run(
			buildInteraction("test", [string("source", "5"), channelOption]),
		);

		expect(reply().content).toContain("could not reach");
	});

	it("explains an empty feed", async () => {
		allowPosting();
		fetchMock.mockResolvedValue(
			ok({
				status: 200,
				url: FeedUrl,
				headers: {},
				body: "<rss><channel></channel></rss>",
			}),
		);
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
		]);

		await runner.run(
			buildInteraction("test", [string("source", "5"), channelOption]),
		);

		expect(reply().content).toContain("nothing published");
	});

	it("names what is wrong with the channel", async () => {
		allowPosting();
		apiMock.guilds.getChannels.mockResolvedValue([]);
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
		]);

		await runner.run(
			buildInteraction("test", [string("source", "5"), channelOption]),
		);

		expect(reply().content).toContain("can no longer see");
	});
});

describe("subscriptions social autocomplete", () => {
	function buildAutocomplete(query: string) {
		return {
			...ApplicationCommandAutocompleteInteractionData,
			guild_id: GuildId,
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
								name: "remove",
								options: [
									{
										type: ApplicationCommandOptionType.String,
										name: "source",
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

	it("lists each followed source once, narrowed by what was typed", async () => {
		const other = {
			...makeSubscription().source,
			id: 6n,
			displayName: "Unrelated",
		};
		prismaMock.guildSocialSubscription.findMany.mockResolvedValue([
			makeSubscription(),
			makeSubscription({ channelId: 1n }),
			makeSubscription({ sourceId: 6n, source: other }),
		]);

		const result = await runner.run(buildAutocomplete("exam") as never);

		expect(result.json()).toMatchObject({
			type: 8,
			data: { choices: [{ name: "Rss: Example", value: "5" }] },
		});
	});
});

describe("subscriptions social registration", () => {
	it("registers the group under the parent command", () => {
		const { options } = applicationCommandRegistry
			.get(ParentCommand)!
			.chatInput!.toJSON();
		const group = options!.find((option) => option.name === GroupName) as
			| { options: { name: string }[] }
			| undefined;

		expect(group!.options.map((option) => option.name).toSorted()).toEqual([
			"add",
			"remove",
			"reset",
			"show",
			"test",
		]);
	});
});
