import {
	ProviderResetCommand,
	buildProviderResetCommand,
} from "#lib/commands/providerReset";
import { RegisterProviderSubcommand } from "#utils/subscriptionProviders";

@RegisterProviderSubcommand(buildProviderResetCommand, "manage")
export class UserCommand extends ProviderResetCommand {}
