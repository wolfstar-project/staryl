import {
	ProviderRemoveCommand,
	buildProviderRemoveCommand,
} from "#lib/commands/providerRemove";
import { RegisterProviderSubcommand } from "#utils/subscriptionProviders";

@RegisterProviderSubcommand(buildProviderRemoveCommand, "manage")
export class UserCommand extends ProviderRemoveCommand {}
