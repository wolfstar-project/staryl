import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { StarylEvents } from "#types";
import { container } from "@wolfstar/http-framework";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserRoute } from "../../src/routes/twitch/event_sub_verify.post.ts";

vi.mock("@wolfstar/twitch-helpers", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@wolfstar/twitch-helpers")>();
	return { ...actual, checkSignature: vi.fn(() => true) };
});

const emit = vi.fn();

function send(messageType: string, body: object) {
	const route = Object.create(UserRoute.prototype) as UserRoute;
	const response = { text: vi.fn(), badRequest: vi.fn(), error: vi.fn() };
	return route.run(
		{
			headers: {
				"twitch-eventsub-message-signature": "sha256=abc",
				"twitch-eventsub-message-id": crypto.randomUUID(),
				"twitch-eventsub-message-timestamp": "2026-11-01T10:00:00Z",
				"twitch-eventsub-message-type": messageType,
			},
			readBodyText: async () => JSON.stringify(body),
		} as unknown as ApiRequest,
		response as unknown as ApiResponse,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	container.client = { emit } as never;
});

describe("POST /twitch/event_sub_verify", () => {
	it("hands a revocation over, so the subscription does not die in silence", async () => {
		const subscription = {
			id: "old",
			status: "notification_failures_exceeded",
			type: "stream.online",
		};

		await send("revocation", { subscription });

		expect(emit).toHaveBeenCalledWith(
			StarylEvents.TwitchSubscriptionRevoked,
			subscription,
		);
	});

	it("does not read a verification request as a revocation", async () => {
		await send("webhook_callback_verification", {
			challenge: "abc",
			subscription: { id: "new", type: "stream.online" },
		});

		expect(emit).not.toHaveBeenCalled();
	});
});
