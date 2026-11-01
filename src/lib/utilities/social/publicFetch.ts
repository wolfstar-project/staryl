import type { Result } from "@sapphire/result";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { lookup } from "node:dns";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP } from "node:net";
import { pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { err, ok } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";

export type PublicFetchError =
	| { _tag: "InvalidUrl" }
	| { _tag: "ForbiddenAddress" }
	| { _tag: "TooLarge" }
	| { _tag: "TooManyRedirects" }
	| { _tag: "Timeout" }
	| { _tag: "NetworkError"; cause: unknown };

export interface PublicResponse {
	status: number;
	/** The URL that answered, after any redirect. */
	url: string;
	headers: IncomingMessage["headers"];
	body: string;
}

export interface PublicFetchPolicy {
	isAllowedAddress(address: string): boolean;
	isAllowedPort(port: number): boolean;
}

export interface PublicFetchOptions {
	headers?: Record<string, string>;
	timeoutMs?: number;
	maximumBytes?: number;
	policy?: PublicFetchPolicy;
}

export type PublicFetcher = typeof fetchPublicUrl;

const DefaultTimeout = Time.Second * 10;
/** Past this a feed is not a feed. Applied after decompression, so a gzip bomb stops here too. */
const DefaultMaximumBytes = 5 * 1024 * 1024;
const MaximumRedirects = 3;
const RedirectStatuses = new Set([301, 302, 303, 307, 308]);

const BlockedAddresses = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	BlockedAddresses.addSubnet(network, prefix, "ipv4");
}

// IPv6 is an allow-list instead: only global unicast is reachable on the internet, and whatever
// else embeds an IPv4 address or points somewhere local is outside of it.
const GlobalUnicast = new BlockList();
GlobalUnicast.addSubnet("2000::", 3, "ipv6");

for (const [network, prefix] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
] as const) {
	BlockedAddresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string) {
	const family = isIP(address);
	if (family === 4) return !BlockedAddresses.check(address, "ipv4");

	return (
		family === 6 &&
		GlobalUnicast.check(address, "ipv6") &&
		!BlockedAddresses.check(address, "ipv6")
	);
}

const PublicInternetPolicy: PublicFetchPolicy = {
	isAllowedAddress: isPublicAddress,
	isAllowedPort: (port) => port === 80 || port === 443,
};

class ForbiddenAddressError extends Error {}

/**
 * Fetches a URL that a Discord member chose, so the request must never reach this host's private
 * network, whatever the URL says.
 *
 * The address is checked inside the socket's own DNS lookup rather than up front. A check made
 * before connecting could be answered with a public address and the connection with a private one,
 * which is how DNS rebinding gets past such a check. Every redirect goes through the same gate.
 */
export async function fetchPublicUrl(
	url: string,
	options: PublicFetchOptions = {},
): Promise<Result<PublicResponse, PublicFetchError>> {
	const policy = options.policy ?? PublicInternetPolicy;
	const signal = AbortSignal.timeout(options.timeoutMs ?? DefaultTimeout);

	let current = url;
	for (let hop = 0; hop <= MaximumRedirects; hop += 1) {
		const parsed = parsePublicUrl(current, policy);
		if (parsed.isErr()) return err(parsed.unwrapErr());

		// oxlint-disable-next-line no-await-in-loop -- each hop depends on the previous response
		const answer = await performRequest(parsed.unwrap(), {
			headers: options.headers ?? {},
			maximumBytes: options.maximumBytes ?? DefaultMaximumBytes,
			policy,
			signal,
		});
		if (answer.isErr()) return err(answer.unwrapErr());

		const response = answer.unwrap();
		if (response._tag === "Response") return ok(response.value);
		if (!URL.canParse(response.location, current)) {
			return err({ _tag: "InvalidUrl" });
		}

		current = new URL(response.location, current).href;
	}

	return err({ _tag: "TooManyRedirects" });
}

function parsePublicUrl(
	input: string,
	policy: PublicFetchPolicy,
): Result<URL, PublicFetchError> {
	if (!URL.canParse(input)) return err({ _tag: "InvalidUrl" });

	const url = new URL(input);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return err({ _tag: "InvalidUrl" });
	}
	if (url.username || url.password) return err({ _tag: "InvalidUrl" });

	const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
	if (!policy.isAllowedPort(port)) return err({ _tag: "ForbiddenAddress" });

	// A literal address never goes through the lookup below.
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(hostname) !== 0 && !policy.isAllowedAddress(hostname)) {
		return err({ _tag: "ForbiddenAddress" });
	}

	return ok(url);
}

function createGuardedLookup(policy: PublicFetchPolicy): LookupFunction {
	return (hostname, options, callback) => {
		lookup(hostname, { ...options, all: true }, (error, addresses) => {
			if (error) {
				callback(error, "", 0);
			} else if (
				addresses.length === 0 ||
				addresses.some(({ address }) => !policy.isAllowedAddress(address))
			) {
				callback(new ForbiddenAddressError(), "", 0);
			} else if (options.all) {
				callback(null, addresses);
			} else {
				callback(null, addresses[0].address, addresses[0].family);
			}
		});
	};
}

type RequestAnswer =
	| { _tag: "Response"; value: PublicResponse }
	| { _tag: "Redirect"; location: string };

function performRequest(
	url: URL,
	options: {
		headers: Record<string, string>;
		maximumBytes: number;
		policy: PublicFetchPolicy;
		signal: AbortSignal;
	},
): Promise<Result<RequestAnswer, PublicFetchError>> {
	const { promise, resolve } =
		Promise.withResolvers<Result<RequestAnswer, PublicFetchError>>();
	const { signal } = options;
	const fail = (error: unknown) => resolve(err(classifyError(error, signal)));

	const send = url.protocol === "https:" ? requestHttps : requestHttp;
	const request = send(
		url,
		{
			headers: {
				"accept-encoding": "gzip, deflate, br",
				...options.headers,
			},
			signal,
			// No pooled socket: each request has to pass through the guarded lookup.
			agent: false,
			lookup: createGuardedLookup(options.policy),
		},
		(response) => {
			const status = response.statusCode ?? 0;
			const { location } = response.headers;
			if (RedirectStatuses.has(status) && location) {
				response.destroy();
				resolve(ok({ _tag: "Redirect", location }));
				return;
			}

			readBody(response, options.maximumBytes)
				.then((bytes) => {
					resolve(
						bytes.map((value) => ({
							_tag: "Response",
							value: {
								status,
								url: url.href,
								headers: response.headers,
								body: decodeBody(value, response.headers["content-type"]),
							},
						})),
					);
				})
				.catch(fail);
		},
	);

	request.once("error", fail);
	request.end();
	return promise;
}

async function readBody(
	response: IncomingMessage,
	maximumBytes: number,
): Promise<Result<Buffer, PublicFetchError>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of decompress(response)) {
		size += (chunk as Buffer).length;
		if (size > maximumBytes) {
			response.destroy();
			return err({ _tag: "TooLarge" });
		}
		chunks.push(chunk as Buffer);
	}

	return ok(Buffer.concat(chunks));
}

function decompress(response: IncomingMessage): Readable {
	const encoding = response.headers["content-encoding"]?.toLowerCase();
	const decoder =
		encoding === "gzip" || encoding === "x-gzip"
			? createGunzip()
			: encoding === "deflate"
				? createInflate()
				: encoding === "br"
					? createBrotliDecompress()
					: null;
	if (!decoder) return response;

	// A failure on either side surfaces through the iteration in `readBody`.
	return pipeline(response, decoder, () => undefined);
}

function decodeBody(bytes: Buffer, contentType: string | undefined) {
	const declared =
		/charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ??
		/^\s*<\?xml[^>]*encoding=["']([\w-]+)/i.exec(
			bytes.subarray(0, 200).toString("latin1"),
		)?.[1];

	try {
		return new TextDecoder(declared ?? "utf-8").decode(bytes);
	} catch {
		// An unknown label throws. Reading it as UTF-8 at worst garbles accents, and that beats
		// refusing a feed that declares an odd charset.
		return new TextDecoder().decode(bytes);
	}
}

function classifyError(error: unknown, signal: AbortSignal): PublicFetchError {
	if (error instanceof ForbiddenAddressError) {
		return { _tag: "ForbiddenAddress" };
	}
	if (signal.aborted) return { _tag: "Timeout" };
	return { _tag: "NetworkError", cause: error };
}
