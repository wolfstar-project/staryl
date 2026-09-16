import type { GuildSubscriptionWithTwitch } from "#twitch/subscriptions";
import { TwitchSubscriptionType } from "#generated/prisma";
import {
	buildAddModal,
	buildClosedSetupMenu,
	buildManagePage,
	buildSetupCustomId,
	buildSetupMenu,
	buildSubscriptionKey,
	buildTestPage,
	isSetupPage,
	parseSubscriptionKey,
} from "#utils/setupMenu";
import { container } from "@wolfstar/http-framework";
import {
	ComponentType,
	InteractionResponseType,
	MessageFlags,
} from "discord-api-types/v10";
import { describe, expect, it } from "vitest";

describe("setup menu", () => {
	const t = container.i18n.getT("en-US");

	it("builds an ephemeral Components V2 overview bound to its owner", () => {
		const payload = buildSetupMenu(
			{
				page: "overview",
				subscriptionCount: 3,
				userId: "123456789",
			},
			t,
		);

		expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
		expect(payload.components).toHaveLength(1);
		expect(payload.components[0]?.type).toBe(ComponentType.Container);
		expect(payload.components[0]?.components[0]).toMatchObject({
			type: ComponentType.TextDisplay,
			content: expect.stringContaining("Current notifications:** 3"),
		});
		expect(JSON.stringify(payload.components)).toContain(
			buildSetupCustomId("123456789", "navigate"),
		);
	});

	it("renders each supported page and rejects unknown page names", () => {
		for (const page of ["overview", "add", "manage", "test"] as const) {
			expect(isSetupPage(page)).toBe(true);
			expect(
				JSON.stringify(
					buildSetupMenu({ page, subscriptionCount: 1, userId: "1" }, t),
				),
			).toContain("components");
		}

		expect(isSetupPage("unknown")).toBe(false);
	});

	it("removes all interactive controls when the menu is closed", () => {
		const payload = buildClosedSetupMenu(t);

		expect(JSON.stringify(payload.components)).toContain("Setup closed");
		expect(JSON.stringify(payload.components)).not.toContain("custom_id");
	});

	it("interpolates the notice into the rendered page text when set", () => {
		const payload = buildSetupMenu(
			{
				page: "overview",
				subscriptionCount: 0,
				userId: "1",
				notice: "Something happened!",
			},
			t,
		);

		expect(payload.components[0]?.components[0]).toMatchObject({
			type: ComponentType.TextDisplay,
			content: expect.stringContaining("Something happened!"),
		});
	});
});

describe("buildAddModal", () => {
	const t = container.i18n.getT("en-US");

	it("builds a modal targeting the add:submit action with every field present", () => {
		const modal = buildAddModal("123456789", t);

		expect(modal.type).toBe(InteractionResponseType.Modal);
		expect(modal.data.custom_id).toBe(
			buildSetupCustomId("123456789", "add:submit"),
		);
		expect(modal.data.title).toBe("Add a Twitch notification");

		const serialized = JSON.stringify(modal.data);
		expect(serialized).toContain('"custom_id":"streamer"');
		expect(serialized).toContain('"custom_id":"channel"');
		expect(serialized).toContain('"custom_id":"type"');
		expect(serialized).toContain('"custom_id":"message"');
	});
});

describe("buildSubscriptionKey / parseSubscriptionKey", () => {
	it("round-trips a channel and subscription id", () => {
		const key = buildSubscriptionKey(123n, 456n);

		expect(key).toBe("123:456");
		expect(parseSubscriptionKey(key)).toEqual({
			channelId: 123n,
			subscriptionId: 456n,
		});
	});

	it("returns null for malformed input", () => {
		expect(parseSubscriptionKey("not-a-key")).toBeNull();
		expect(parseSubscriptionKey("123")).toBeNull();
		expect(parseSubscriptionKey("123:456:789")).toBeNull();
		expect(parseSubscriptionKey("abc:456")).toBeNull();
		expect(parseSubscriptionKey("123:abc")).toBeNull();
		expect(parseSubscriptionKey("")).toBeNull();
	});
});

function buildSubscription(
	channelId: bigint,
	subscriptionId: bigint,
	streamerId: string,
	subscriptionType: TwitchSubscriptionType = TwitchSubscriptionType.StreamOnline,
): GuildSubscriptionWithTwitch {
	return {
		guildId: 1n,
		channelId,
		subscriptionId,
		message: null,
		twitchSubscription: {
			id: subscriptionId,
			streamerId,
			subscriptionId: `event-${subscriptionId}`,
			subscriptionType,
		},
	} as GuildSubscriptionWithTwitch;
}

const Statuses = { live: "Live", offline: "Offline" };

describe("buildManagePage", () => {
	const t = container.i18n.getT("en-US");

	it("renders no select when the guild has no subscriptions", () => {
		const rows = buildManagePage(
			{ page: "manage", subscriptionCount: 0, userId: "1" },
			[],
			new Map(),
			Statuses,
			t,
		);

		expect(JSON.stringify(rows)).not.toContain(
			buildSetupCustomId("1", "manage:select"),
		);
		expect(JSON.stringify(rows)).toContain(
			buildSetupCustomId("1", "manage:reset:open"),
		);
	});

	it("renders a select with one option per subscription", () => {
		const subscriptions = [
			buildSubscription(10n, 100n, "streamer-a"),
			buildSubscription(20n, 200n, "streamer-b"),
		];
		const rows = buildManagePage(
			{ page: "manage", subscriptionCount: 2, userId: "1" },
			subscriptions,
			new Map([
				["streamer-a", "Streamer A"],
				["streamer-b", "Streamer B"],
			]),
			Statuses,
			t,
		);

		const selectRow = rows.find((row) =>
			row.components.some(
				(component) => component.type === ComponentType.StringSelect,
			),
		);
		expect(selectRow).toBeDefined();
		const select = selectRow!.components[0] as {
			custom_id: string;
			options: unknown[];
		};
		expect(select.custom_id).toBe(buildSetupCustomId("1", "manage:select"));
		expect(select.options).toHaveLength(2);
	});

	it("shows the confirm button instead of the open button while confirming a reset", () => {
		const rows = buildManagePage(
			{
				page: "manage",
				subscriptionCount: 0,
				userId: "1",
				confirmingReset: true,
			},
			[],
			new Map(),
			Statuses,
			t,
		);

		const serialized = JSON.stringify(rows);
		expect(serialized).toContain(
			buildSetupCustomId("1", "manage:reset:confirm"),
		);
		expect(serialized).not.toContain(
			buildSetupCustomId("1", "manage:reset:open"),
		);
	});
});

describe("buildTestPage", () => {
	const t = container.i18n.getT("en-US");

	it("renders no rows when the guild has no subscriptions", () => {
		const rows = buildTestPage(
			{ page: "test", subscriptionCount: 0, userId: "1" },
			[],
			new Map(),
			Statuses,
			t,
		);

		expect(rows).toHaveLength(0);
	});

	it("renders a single-select with one option per subscription", () => {
		const subscriptions = [
			buildSubscription(10n, 100n, "streamer-a"),
			buildSubscription(20n, 200n, "streamer-b"),
		];
		const rows = buildTestPage(
			{ page: "test", subscriptionCount: 2, userId: "1" },
			subscriptions,
			new Map([
				["streamer-a", "Streamer A"],
				["streamer-b", "Streamer B"],
			]),
			Statuses,
			t,
		);

		expect(rows).toHaveLength(1);
		const select = rows[0]!.components[0] as {
			custom_id: string;
			options: unknown[];
		};
		expect(select.custom_id).toBe(buildSetupCustomId("1", "test:select"));
		expect(select.options).toHaveLength(2);
	});
});
