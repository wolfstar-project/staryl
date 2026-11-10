import {
	ProviderConnectCommand,
	buildProviderConnectCommand,
} from "#lib/commands/providerConnect";
import { RegisterProviderSubcommand } from "#utils/subscriptionProviders";

@RegisterProviderSubcommand(buildProviderConnectCommand, "connect")
export class UserCommand extends ProviderConnectCommand {}
