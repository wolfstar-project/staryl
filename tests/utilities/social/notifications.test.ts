import type { SocialCard, SocialItem, SocialProvider } from "#social/provider";
import {
	buildSocialComponents,
	createSocialCard,
	escapeInlineText,
	parseImageUrl,
	parseItemUrl,
	socialDelivery,
} from "#social/notifications";
import { NotificationDeliveryError } from "#utils/notificationDelivery";
import { ok } from "@sapphire/result";
import { container } from "@wolfstar/http-framework";
import { ComponentType } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";

vi.mock("#utils/notificationDelivery", async (importOriginal) => ({
	...(await importOriginal<typeof import("#utils/notificationDelivery")>()),
	resolveNotificationTarget: vi.fn(),
	sendNotificationMessage: vi.fn(async () => ok()),
}));

const Card: SocialCard = {
	accentColor: 0x123456,
	heading: "New post",
	title: null,
	url: "https://example.com/1",
	body: null,
	thumbnailUrl: null,
	imageUrl: null,
	footer: "Staryl",
	linkLabel: "Open",
	publishedAt: null,
};

const Item: SocialItem = {
	id: "1",
	url: "https://example.com/1",
	title: "*bold* [link](https://evil.example)",
	text: "x".repeat(600),
	authorName: null,
	authorAvatarUrl: null,
	imageUrl: null,
	publishedAt: null,
};

function collectText(components: ReturnType<typeof buildSocialComponents>) {
	return JSON.stringify(components);
}

describe("parseItemUrl", () => {
	it.each([
		["https://example.com/a", "https://example.com/a"],
		["http://example.com/a", "http://example.com/a"],
		["https://example.com/a_(b)", "https://example.com/a_(b%29"],
	])("accepts %s", (url, expected) => {
		expect(parseItemUrl(url)).toBe(expected);
	});

	it.each([
		"javascript:alert(1)",
		"ftp://example.com/a",
		"not a url",
		"",
		null,
		undefined,
		`https://example.com/${"a".repeat(600)}`,
	])("refuses %s", (url) => {
		expect(parseItemUrl(url)).toBeNull();
	});
});

describe("parseImageUrl", () => {
	it("only accepts https", () => {
		expect(parseImageUrl("https://example.com/a.png")).toBe(
			"https://example.com/a.png",
		);
		expect(parseImageUrl("http://example.com/a.png")).toBeNull();
	});
});

describe("escapeInlineText", () => {
	it("keeps source text from forming a link or styling the card", () => {
		expect(escapeInlineText("*a* [b](c)")).toBe("\\*a\\* \\[b\\](c)");
	});

	it.each([
		["# Heading", "\\# Heading"],
		["- item", "\\- item"],
		["1. item", "1\\. item"],
	])("keeps %j from becoming a heading or a list", (text, escaped) => {
		expect(escapeInlineText(text)).toBe(escaped);
	});
});

describe("createSocialCard", () => {
	it("escapes and shortens what the source wrote", () => {
		const card = createSocialCard(Item, Card);
		expect(card.title).toBe(
			"\\*bold\\* \\[link\\](https://evil\\.example)".replace("\\.", "."),
		);
		expect(card.body!.length).toBeLessThanOrEqual(500);
	});

	it("keeps a title on the line of its heading", () => {
		const card = createSocialCard({ ...Item, title: "One\n\ntwo" }, Card);

		expect(card.title).toBe("One two");
	});

	it("drops a picture Discord would refuse", () => {
		const card = createSocialCard(
			{
				...Item,
				authorAvatarUrl: "/avatar.png",
				imageUrl: "http://example.com/image.png",
			},
			Card,
		);

		expect(card).toMatchObject({ thumbnailUrl: null, imageUrl: null });
	});

	it("leaves out a date the source got wrong", () => {
		const card = createSocialCard(
			{ ...Item, publishedAt: new Date("not a date") },
			Card,
		);

		expect(card.publishedAt).toBeNull();
	});

	it("leaves out a missing title and text", () => {
		const card = createSocialCard({ ...Item, title: "", text: null }, Card);
		expect(card).toMatchObject({ title: null, body: null });
	});
});

describe("socialDelivery", () => {
	it("escapes and shortens the names a heading is built from", async () => {
		const formatNotification = vi.fn(() => Card);
		const provider = { formatNotification } as unknown as SocialProvider;

		await socialDelivery.send({ channel: { id: "1" }, t: vi.fn() } as never, {
			provider,
			item: {
				...Item,
				authorName: `[a](https://evil.example)${"x".repeat(200)}`,
			},
			source: { target: "t", displayName: "*Name*" },
			message: null,
		});

		const [item, source] = formatNotification.mock.calls[0] as unknown as [
			SocialItem,
			{ displayName: string },
		];
		expect(item.authorName).toMatch(/^\\\[a\\\]/);
		expect(item.authorName!.length).toBeLessThan(120);
		expect(source.displayName).toBe("\\*Name\\*");
	});

	it("reports a card the builders refuse, instead of throwing", async () => {
		const error = vi
			.spyOn(container.logger, "error")
			.mockImplementation(() => undefined);
		const provider = {
			formatNotification: () => ({ ...Card, url: "/relative" }),
		} as unknown as SocialProvider;

		const result = await socialDelivery.send(
			{ channel: { id: "1" }, t: vi.fn() } as never,
			{
				provider,
				item: Item,
				source: { target: "t", displayName: "Name" },
				message: null,
			},
		);

		expect(result.unwrapErr()).toBe(NotificationDeliveryError.SendFailed);
		expect(error).toHaveBeenCalledOnce();
	});
});

describe("buildSocialComponents", () => {
	it("always ends with a link button to the item", () => {
		const components = buildSocialComponents(Card);
		expect(components.at(-1)).toMatchObject({
			type: ComponentType.ActionRow,
			components: [{ url: Card.url, label: Card.linkLabel }],
		});
	});

	it("links the title when there is one", () => {
		const components = buildSocialComponents({ ...Card, title: "Title" });
		expect(collectText(components)).toContain(`### [Title](${Card.url})`);
	});

	it("puts the text beside a thumbnail when there is one", () => {
		const [container] = buildSocialComponents({
			...Card,
			thumbnailUrl: "https://example.com/avatar.png",
		});
		expect(container).toMatchObject({
			components: [
				{
					type: ComponentType.Section,
					accessory: { media: { url: "https://example.com/avatar.png" } },
				},
				{ type: ComponentType.TextDisplay },
			],
		});
	});

	it("adds a gallery for the item's picture", () => {
		const [container] = buildSocialComponents({
			...Card,
			imageUrl: "https://example.com/image.png",
		});
		expect(container).toMatchObject({
			components: expect.arrayContaining([
				expect.objectContaining({ type: ComponentType.MediaGallery }),
			]),
		});
	});

	it("timestamps the footer when the date is known", () => {
		const publishedAt = new Date(1_000_000);
		const components = buildSocialComponents({ ...Card, publishedAt });
		expect(collectText(components)).toContain("Staryl • <t:1000:f>");
	});
});
