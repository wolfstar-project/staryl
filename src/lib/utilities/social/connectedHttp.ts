import type { ProviderFailure } from "#social/provider";
import type { Result } from "@sapphire/result";
import { sendRequest, toHttpFailure } from "#social/http";
import { err, ok, Result as Results } from "@sapphire/result";
import { isObject } from "@sapphire/utilities";

export async function readConnectedJson<T>(
	request: typeof fetch,
	url: string,
	init: RequestInit = {},
	classifyFailure?: (response: Response) => Promise<ProviderFailure>,
): Promise<Result<T, ProviderFailure>> {
	const response = await sendRequest(request, url, init);
	if (response.isErr()) return err(response.unwrapErr());
	const answer = response.unwrap();
	if (!answer.ok)
		return err(
			classifyFailure
				? await classifyFailure(answer)
				: toHttpFailure(answer.status, answer.headers.get("retry-after")),
		);
	const body = await Results.fromAsync(() => answer.json());
	if (body.isErr() || !isObject(body.unwrap()))
		return err({ _tag: "InvalidResponse" });
	return ok(body.unwrap() as T);
}
