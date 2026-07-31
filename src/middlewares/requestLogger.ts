import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { ApplyOptions } from "#utils/applyOptions";
import { container } from "@sapphire/pieces";
import { Middleware } from "@wolfstar/plugin-api";

@ApplyOptions<Middleware.Options>({ position: 30 })
export class RequestLoggerMiddleware extends Middleware {
	public run(request: ApiRequest, response: ApiResponse) {
		if (process.env.NODE_ENV !== "development") return;

		response.once("finish", () => {
			container.logger.info(
				`${request.method} ${request.url} → ${response.statusCode}`,
			);
		});
	}
}
