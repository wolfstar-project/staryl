import type { ProviderFailure } from "#social/provider";
import type { Result } from "@sapphire/result";
import { err, ok } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";

const RequestTimeout = Time.Second * 10;
/** A server does not get to park a source, or everything sharing its budget, for a year. */
const MaximumRetryAfter = Time.Hour * 6;

/** Sites and APIs ask bots to say who they are, and masking it is what most terms forbid. */
export const SocialUserAgent = `Staryl/${process.env.CLIENT_VERSION ?? "1.0.0"} (+https://github.com/wolfstar-project/staryl)`;

/** Reads a `Retry-After` header, which is either a number of seconds or an HTTP date. */
export function parseRetryAfter(
	value: string | null | undefined,
	now = Date.now(),
): number | null {
	if (!value) return null;

	const text = value.trim();
	const wait = /^\d+$/.test(text)
		? Number(text) * Time.Second
		: Date.parse(text) - now;
	return Number.isNaN(wait)
		? null
		: Math.min(Math.max(wait, 0), MaximumRetryAfter);
}

export function toHttpFailure(
	status: number,
	retryAfter?: string | null,
): ProviderFailure {
	if (status === 429) {
		return { _tag: "RateLimited", retryAfterMs: parseRetryAfter(retryAfter) };
	}
	if (status === 503 && retryAfter) {
		return { _tag: "RateLimited", retryAfterMs: parseRetryAfter(retryAfter) };
	}
	if (status === 401 || status === 403) return { _tag: "AuthFailed" };
	if (status === 404 || status === 410 || status === 451) {
		return { _tag: "TargetUnavailable" };
	}
	return { _tag: "Unavailable" };
}

/** Calls an API on a fixed host. A URL a member chose goes through `fetchPublicUrl` instead. */
export async function sendRequest(
	request: typeof fetch,
	url: string,
	init: RequestInit = {},
): Promise<Result<Response, ProviderFailure>> {
	try {
		return ok(
			await request(url, {
				...init,
				signal: AbortSignal.timeout(RequestTimeout),
			}),
		);
	} catch {
		// Timeouts and connection failures both just mean the API could not be reached right now.
		return err({ _tag: "Unavailable" });
	}
}
