import {
	ProviderTestCommand,
	buildProviderTestCommand,
} from "#lib/commands/providerTest";
import { RegisterProviderSubcommand } from "#utils/subscriptionProviders";

@RegisterProviderSubcommand(buildProviderTestCommand, "manage")
export class UserCommand extends ProviderTestCommand {}
