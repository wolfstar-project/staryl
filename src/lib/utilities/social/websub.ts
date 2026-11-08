import { createHmac, timingSafeEqual } from "node:crypto";
import { SocialProviderName } from "#generated/prisma";
import { container } from "@wolfstar/http-framework";

const TopicPrefix = "https://www.youtube.com/xml/feeds/videos.xml?channel_id=";
const ChannelIdPattern = /^UC[\w-]{22}$/;
const SignatureAlgorithms = new Set(["sha1", "sha256", "sha384", "sha512"]);
/** A push is a small Atom document. The sender is unknown until the body has been read. */
const MaximumPushBytes = 64 * 1024;

export function isWebSubConfigured(
	env: Record<string, string | undefined> = process.env,
) {
	// A typo in the callback has to cost the pushes, not every check of every channel.
	return (
		Boolean(env.YOUTUBE_WEBSUB_SECRET) &&
		URL.canParse(env.YOUTUBE_WEBSUB_CALLBACK ?? "")
	);
}

export function getChannelTopic(channelId: string) {
	return `${TopicPrefix}${channelId}`;
}

export function parseTopicChannelId(topic: unknown) {
	if (typeof topic !== "string" || !topic.startsWith(TopicPrefix)) return null;

	const channelId = topic.slice(TopicPrefix.length);
	return ChannelIdPattern.test(channelId) ? channelId : null;
}

/**
 * Part of the callback URL given to the hub. Anyone can ask a hub to subscribe our endpoint, and
 * with their own secret every real push would then fail the signature check, so a confirmation is
 * only given to a callback only we could have built.
 */
export function getCallbackToken(secret: string, channelId: string) {
	return createHmac("sha256", secret).update(channelId).digest("hex");
}

export function isValidCallbackToken(
	secret: string,
	channelId: string,
	token: unknown,
) {
	if (typeof token !== "string") return false;

	const expected = Buffer.from(getCallbackToken(secret, channelId));
	const received = Buffer.from(token);
	return (
		expected.length === received.length && timingSafeEqual(expected, received)
	);
}

/**
 * Reads a push, or answers `null` when it is too big to be one. The stream is read by hand because
 * nothing has been authenticated yet, and a chunked body would pass any `content-length` check.
 */
export async function readPushBody(request: AsyncIterable<Buffer>) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MaximumPushBytes) return null;
		chunks.push(chunk);
	}

	return Buffer.concat(chunks).toString("utf8");
}

/** Checks the `X-Hub-Signature` a hub computes over the body with the secret we subscribed with. */
export function isValidHubSignature(
	secret: string,
	header: unknown,
	body: string,
) {
	if (typeof header !== "string") return false;

	const [algorithm, signature] = header.split("=", 2);
	if (!signature || !SignatureAlgorithms.has(algorithm)) return false;

	const expected = createHmac(algorithm, secret).update(body).digest();
	const received = Buffer.from(signature, "hex");
	return (
		expected.length === received.length && timingSafeEqual(expected, received)
	);
}

export function extractChannelIds(xml: string) {
	const ids = xml.matchAll(
		/<yt:channelId>\s*(UC[\w-]{22})\s*<\/yt:channelId>/g,
	);
	return [...new Set([...ids].map(([, id]) => id))];
}

export async function confirmYouTubeLease(channelId: string, seconds: number) {
	await container.prisma.socialSource.updateMany({
		where: { provider: SocialProviderName.YouTube, target: channelId },
		data: {
			websubExpiresAt: new Date(Date.now() + Math.min(seconds, 86400) * 1000),
		},
	});
}

export async function isFollowedChannel(channelId: string) {
	const count = await container.prisma.socialSource.count({
		where: { provider: SocialProviderName.YouTube, target: channelId },
	});
	return count > 0;
}

/**
 * Asks for a channel to be checked now. A push is only ever a hint to look: what gets posted still
 * comes from the feed through the regular check, so the push path cannot post anything by itself,
 * and a video that arrives twice is deduplicated like any other item.
 */
export function wakeChannel(channelId: string) {
	return container.prisma.socialSource.updateMany({
		where: { provider: SocialProviderName.YouTube, target: channelId },
		data: { checkRequested: true },
	});
}
