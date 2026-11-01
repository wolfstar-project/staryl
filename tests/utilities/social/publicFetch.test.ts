import type { PublicFetchPolicy } from "#social/publicFetch";
import type { RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fetchPublicUrl, isPublicAddress } from "#social/publicFetch";
import { afterEach, describe, expect, it } from "vitest";

/** Lets the code under test reach the local server, and nothing else changes. */
const LocalPolicy: PublicFetchPolicy = {
	isAllowedAddress: () => true,
	isAllowedPort: () => true,
};

const closers: (() => void)[] = [];

async function serve(listener: RequestListener) {
	const server = createServer(listener);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	closers.push(() => server.close());
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => {
	for (const close of closers.splice(0)) close();
});

describe("isPublicAddress", () => {
	it.each([
		"127.0.0.1",
		"10.0.0.1",
		"172.16.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"::1",
		"::",
		"fe80::1",
		"fc00::1",
		"fd00::1",
		"::ffff:127.0.0.1",
		"::ffff:169.254.169.254",
		"::7f00:1",
		"::a00:1",
		"::ffff:0:7f00:1",
		"64:ff9b::7f00:1",
		"64:ff9b:1::7f00:1",
		"2001:0:7f00:1::1",
		"2002:7f00:1::1",
		"2001:db8::1",
		"2001:10::1",
		"3fff::1",
		"5f00::1",
		"fec0::1",
		"100::1",
		"192.88.99.1",
		"not an address",
	])("refuses %s", (address) => {
		expect(isPublicAddress(address)).toBe(false);
	});

	it.each([
		"1.1.1.1",
		"8.8.8.8",
		"2606:4700:4700::1111",
		"2001:4860:4860::8888",
		"2a00:1450:4001::1",
	])("accepts %s", (address) => {
		expect(isPublicAddress(address)).toBe(true);
	});
});

describe("fetchPublicUrl with the default policy", () => {
	it.each([
		["a private address", "http://192.168.1.1/feed"],
		["the loopback address", "http://127.0.0.1/feed"],
		["the cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
		["an IPv6 loopback", "http://[::1]/feed"],
		["a mapped IPv6 address", "http://[::ffff:7f00:1]/feed"],
		["a port other than the web ones", "http://1.1.1.1:6379/"],
	])("refuses %s", async (_, url) => {
		const result = await fetchPublicUrl(url);

		expect(result.unwrapErr()).toEqual({ _tag: "ForbiddenAddress" });
	});

	it("refuses a name that resolves to this machine", async () => {
		const result = await fetchPublicUrl("http://localhost/feed");

		expect(result.unwrapErr()).toEqual({ _tag: "ForbiddenAddress" });
	});

	it.each(["file:///etc/passwd", "ftp://example.com/", "not a url"])(
		"refuses %s as a URL",
		async (url) => {
			const result = await fetchPublicUrl(url);

			expect(result.unwrapErr()).toEqual({ _tag: "InvalidUrl" });
		},
	);

	it("refuses credentials in the URL", async () => {
		const result = await fetchPublicUrl("https://user:pass@example.com/");

		expect(result.unwrapErr()).toEqual({ _tag: "InvalidUrl" });
	});
});

describe("fetchPublicUrl", () => {
	it("answers the status, the headers and the body", async () => {
		const url = await serve((_, response) => {
			response.setHeader("etag", '"abc"');
			response.end("hello");
		});

		const result = await fetchPublicUrl(url, { policy: LocalPolicy });

		expect(result.unwrap()).toMatchObject({
			status: 200,
			body: "hello",
			headers: { etag: '"abc"' },
		});
	});

	it("sends the requested headers", async () => {
		const url = await serve((request, response) => {
			response.end(request.headers["if-none-match"]);
		});

		const result = await fetchPublicUrl(url, {
			headers: { "if-none-match": "tag" },
			policy: LocalPolicy,
		});

		expect(result.unwrap().body).toBe("tag");
	});

	it.each([
		["gzip", gzipSync("compressed")],
		["br", brotliCompressSync("compressed")],
	])("reads a %s body", async (encoding, body) => {
		const url = await serve((_, response) => {
			response.setHeader("content-encoding", encoding);
			response.end(body);
		});

		const result = await fetchPublicUrl(url, { policy: LocalPolicy });

		expect(result.unwrap().body).toBe("compressed");
	});

	it("honours the charset the response declares", async () => {
		const url = await serve((_, response) => {
			response.setHeader("content-type", "text/xml; charset=iso-8859-1");
			response.end(Buffer.from("café", "latin1"));
		});

		const result = await fetchPublicUrl(url, { policy: LocalPolicy });

		expect(result.unwrap().body).toBe("café");
	});

	it("honours the charset an XML declaration names", async () => {
		const url = await serve((_, response) => {
			response.end(
				Buffer.concat([
					Buffer.from('<?xml version="1.0" encoding="iso-8859-1"?>'),
					Buffer.from("é", "latin1"),
				]),
			);
		});

		const result = await fetchPublicUrl(url, { policy: LocalPolicy });

		expect(result.unwrap().body).toContain("é");
	});

	it("reads an unknown charset as UTF-8 instead of failing", async () => {
		const url = await serve((_, response) => {
			response.setHeader("content-type", "text/xml; charset=nonsense");
			response.end("plain");
		});

		const result = await fetchPublicUrl(url, { policy: LocalPolicy });

		expect(result.unwrap().body).toBe("plain");
	});

	it("follows a redirect and reports where it ended", async () => {
		const url = await serve((request, response) => {
			if (request.url === "/old") {
				response.statusCode = 301;
				response.setHeader("location", "/new");
				response.end();
				return;
			}
			response.end("moved");
		});

		const result = await fetchPublicUrl(`${url}/old`, { policy: LocalPolicy });

		expect(result.unwrap()).toMatchObject({
			body: "moved",
			url: `${url}/new`,
		});
	});

	it("reports a redirect to something that is not a URL", async () => {
		const url = await serve((_, response) => {
			response.statusCode = 302;
			response.setHeader("location", "https://[");
			response.end();
		});

		const result = await fetchPublicUrl(url, { policy: LocalPolicy });

		expect(result.unwrapErr()).toEqual({ _tag: "InvalidUrl" });
	});

	it("gives up on a body that stalls halfway", async () => {
		const url = await serve((_, response) => {
			response.write("partial");
		});

		const result = await fetchPublicUrl(url, {
			timeoutMs: 50,
			policy: LocalPolicy,
		});

		expect(result.unwrapErr()).toEqual({ _tag: "Timeout" });
	});

	it("stops following a redirect loop", async () => {
		const url = await serve((_, response) => {
			response.statusCode = 302;
			response.setHeader("location", "/again");
			response.end();
		});

		const result = await fetchPublicUrl(url, { policy: LocalPolicy });

		expect(result.unwrapErr()).toEqual({ _tag: "TooManyRedirects" });
	});

	it("does not follow a redirect towards a private address", async () => {
		const url = await serve((_, response) => {
			response.statusCode = 302;
			response.setHeader("location", "http://169.254.169.254/latest/");
			response.end();
		});

		const result = await fetchPublicUrl(url, {
			policy: {
				isAllowedAddress: (address) => address !== "169.254.169.254",
				isAllowedPort: () => true,
			},
		});

		expect(result.unwrapErr()).toEqual({ _tag: "ForbiddenAddress" });
	});

	it("stops reading past the size limit", async () => {
		const url = await serve((_, response) => {
			response.end("x".repeat(1024));
		});

		const result = await fetchPublicUrl(url, {
			maximumBytes: 100,
			policy: LocalPolicy,
		});

		expect(result.unwrapErr()).toEqual({ _tag: "TooLarge" });
	});

	it("applies the size limit to the decompressed size", async () => {
		const url = await serve((_, response) => {
			response.setHeader("content-encoding", "gzip");
			response.end(gzipSync(Buffer.alloc(1024 * 1024)));
		});

		const result = await fetchPublicUrl(url, {
			maximumBytes: 1024,
			policy: LocalPolicy,
		});

		expect(result.unwrapErr()).toEqual({ _tag: "TooLarge" });
	});

	it("gives up on a server that never answers", async () => {
		const url = await serve(() => undefined);

		const result = await fetchPublicUrl(url, {
			timeoutMs: 50,
			policy: LocalPolicy,
		});

		expect(result.unwrapErr()).toEqual({ _tag: "Timeout" });
	});

	it("reports a refused connection", async () => {
		const url = await serve(() => undefined);
		for (const close of closers.splice(0)) close();

		const result = await fetchPublicUrl(url, { policy: LocalPolicy });

		expect(result.unwrapErr()).toMatchObject({ _tag: "NetworkError" });
	});

	it("reports a corrupt compressed body", async () => {
		const url = await serve((_, response) => {
			response.setHeader("content-encoding", "gzip");
			response.end("this is not gzip");
		});

		const result = await fetchPublicUrl(url, { policy: LocalPolicy });

		expect(result.unwrapErr()).toMatchObject({ _tag: "NetworkError" });
	});
});
