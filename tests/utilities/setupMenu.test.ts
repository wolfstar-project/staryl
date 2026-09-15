import {
	buildClosedSetupMenu,
	buildSetupCustomId,
	buildSetupMenu,
	isSetupPage,
} from "#utils/setupMenu";
import { container } from "@wolfstar/http-framework";
import { ComponentType, MessageFlags } from "discord-api-types/v10";
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
});
