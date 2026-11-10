import {
	ProviderShowCommand,
	buildProviderShowCommand,
} from "#lib/commands/providerShow";
import { RegisterProviderSubcommand } from "#utils/subscriptionProviders";

@RegisterProviderSubcommand(buildProviderShowCommand, "manage")
export class UserCommand extends ProviderShowCommand {}
