import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { HttpCodes } from "@wolfstar/http-framework";
import { Route } from "@wolfstar/plugin-api";

export class HelloWorldRoute extends Route {
	public run(_request: ApiRequest, response: ApiResponse) {
		response.json({ data: "Hello world" }, HttpCodes.OK);
	}
}
