import {
	ProviderAddCommand,
	buildProviderAddCommand,
} from "#lib/commands/providerAdd";
import { RegisterProviderSubcommand } from "#utils/subscriptionProviders";

@RegisterProviderSubcommand(buildProviderAddCommand, "add")
export class UserCommand extends ProviderAddCommand {}
