# Core Requirements

- The end goal is stability, speed, and reliability.
- Starly is a Discord notification bot built with TypeScript that integrates
  with Twitch EventSub to provide stream status notifications. It uses HTTP
  interactions via Discord's HTTP-based bot architecture
  (`@wolfstar/http-framework`) rather than a persistent WebSocket connection.
- Always reference these instructions first and fall back to search or
  documentation queries only when you encounter unexpected information.

## Code Quality Requirements

- Follow standard TypeScript conventions and best practices with strict mode
- Use the `@wolfstar/http-framework` decorator pattern (`@RegisterCommand`,
  `@RegisterSubcommand`) for Discord slash commands, or the
  `@wolfstar/plugin-subcommands-advanced` parent/child pattern
  (`@RegisterAsSubcommandGroup`) when a command has enough subcommands to
  warrant a file each
- Use clear, descriptive variable and function names
- Add comments only to explain complex logic or non-obvious implementations
- Keep functions focused and manageable (generally under 50 lines)
- Use error handling patterns consistently, preferring `@sapphire/result` for
  fallible operations
- Ensure strictly type-safe code, for example by always checking when accessing
  an array value by index
- Never cast things to `any`; use `@sapphire/utilities` helpers like `cast<T>()`
  when narrowing is needed
- Use `const enum` for internal-only enumerations (prefixed with
  `oxlint-disable-next-line no-restricted-syntax`)
- Use standard `enum` for values that cross module boundaries or are used in
  Prisma

## Naming Conventions

| Type             | Convention      | Example                                                |
| ---------------- | --------------- | ------------------------------------------------------ |
| Directories      | kebab-case      | `feature-name/`                                        |
| TypeScript files | camelCase       | `twitchStreamOnline.ts`                                |
| Variables        | camelCase       | `guildId`, `streamerId`                                |
| Constants        | PascalCase enum | `Colors.Amber`, `StarylEvents.TwitchStreamOnline`      |
| Path constants   | PascalCase      | `PathRoot`, `PathSrc`                                  |
| Types/Interfaces | PascalCase      | `GuildSubscription`, `DetailedMentionExtractionResult` |
| Classes          | PascalCase      | `UserCommand`, `UserRoute`                             |
| Enum members     | PascalCase      | `TwitchStreamStatus.Online`                            |
| Private methods  | `#`-prefixed    | `this.#getStreamer()`                                  |

## Import Conventions

- Use TypeScript path mapping aliases for internal imports: `#lib/*`,
  `#utils/*`, `#common/*`, `#types/*`, `#twitch/*` (Twitch-specific utilities,
  `src/lib/utilities/twitch/`), and `#generated/prisma` (the generated client)
- Use `type` imports for type-only values: `import type { ... } from "..."`
- Group imports: type imports first, then internal aliases, then external
  packages
- Prefer importing from barrel files (such as `#lib/types`) over deep paths

## Project Architecture

### Key Patterns

- **HTTP Framework**: Built on `@wolfstar/http-framework`, handling Discord
  interactions via HTTP endpoints instead of WebSocket gateway
- **Automatic Plugin Registration**: `@wolfstar/plugin-api`,
  `@wolfstar/plugin-i18next`, `@wolfstar/plugin-subcommands-advanced`, and
  `@wolfstar/plugin-logger` no longer need a side-effect `import
  "@wolfstar/plugin-x/register"` in `src/main.ts` / `src/lib/setup/all.ts` —
  the Stars CLI activates any plugin it finds declared in `dependencies`
  automatically. `@wolfstar/shared-http-pieces/register` is the one remaining
  explicit side-effect import, since command/route registration isn't part of
  this auto-activation.
- **Database**: PostgreSQL with Prisma ORM. Models use `@@map()` for snake_case
  table names, `@map()` for snake_case column names
- **Event System**: Twitch EventSub webhooks trigger internal events
  (`StarylEvents.TwitchStreamOnline`, `StarylEvents.TwitchStreamOffline`) that
  listeners handle
- **i18n**: Multi-language support via `@wolfstar/plugin-i18next`, with keys
  type-checked through the augmentation generated in `src/@types/i18next.d.ts`.
  It installs an `InternationalizationHandler` on `container.i18n` and loads
  the locales before the stores, so command builders are localized at
  registration time. Locale discovery is configured through the `i18n` key of
  the `Client` options.
- **Rate Limiting**: Use `@sapphire/ratelimits` `RateLimitManager` for
  notification drip control
- **Testable Listener Logic**: `Listener` pieces have no test harness, so
  business logic that needs coverage (building/sending a notification, resolving
  a target channel, etc.) lives in a `#utils/*` or `#twitch/*` module returning
  `Result<T, E>` instead of a private listener method; the listener becomes a
  thin loop that calls the module and logs on `isErr()`. This also lets a
  command (e.g. `/subscriptions twitch test`, `/setup`) reuse the exact same
  delivery path as the listeners. See `src/lib/utilities/twitch/notifications.ts`
  (imported as `#twitch/notifications`) / `tests/utilities/twitchNotifications.test.ts`.
- **Interaction Handlers**: Message-component and modal-submit interactions
  (buttons, select menus, modals) triggered by a command's own UI — as opposed
  to a fresh slash-command invocation — are routed to `InteractionHandler`
  pieces loaded from `src/interaction-handlers/`. Encode routing state in the
  component's `custom_id` (e.g. `[ownerId, action]`) rather than server-side
  session storage, and re-check permissions on every action instead of trusting
  the id captured at the initial command invocation, since the component can
  outlive that check. See `src/interaction-handlers/setup.ts`, which backs the
  `/setup` menu built by `src/lib/utilities/setupMenu.ts`.

### Directory Structure

- `src/main.ts` - Application entry point
- `src/routes/` - HTTP API endpoints (`@wolfstar/plugin-api` `Route` pieces,
  e.g. Twitch EventSub webhooks)
- `src/middlewares/` - HTTP API middlewares (`@wolfstar/plugin-api` `Middleware`
  pieces)
- `src/commands/` - Discord slash commands using decorator pattern
- `src/interaction-handlers/` - `InteractionHandler` pieces that route a
  command's own message-component/modal interactions (e.g. `/setup`'s menu)
- `src/listeners/` - Event listeners for Twitch stream events
- `src/lib/setup/` - Application initialization (env, Prisma, the shared
  `@discordjs/core` REST `api()` client, logger)
- `src/lib/utilities/` - Helper functions (Discord API, mention parsing); Twitch
  helpers live under `src/lib/utilities/twitch/` (`index.ts`, `notifications.ts`,
  `subscriptions.ts`), aliased as `#twitch` / `#twitch/*`
- `src/lib/common/` - Shared constants, error handling, promise utilities
- `src/lib/types/` - TypeScript type definitions and enums
- `src/@types/` - Ambient type declarations, including the i18next resource
  augmentation generated by `pnpm i18n:generate` (`src/@types/i18next.d.ts`) and
  the default-namespace configuration (`src/@types/i18next-options.d.ts`)
- `src/locales/` - Translation JSON files organized by locale
- `prisma/schema.prisma` - Database schema
- `tests/` - Vitest test suite, organized by area
  (`tests/commands/subscriptions.test.ts` tests `src/commands/subscriptions/`;
  `tests/utilities/twitchNotifications.test.ts` tests
  `src/lib/utilities/twitch/notifications.ts`); `tests/setup.ts` registers the
  `@wolfstar/http-framework-test-utils` matchers and boots i18n

### Command Structure

Commands use the decorator pattern from `@wolfstar/http-framework`:

```typescript
@RegisterCommand((builder) =>
  builder
    .setName("command-name")
    .setDescription("commands/namespace:description")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
)
export class UserCommand extends Command {
  @RegisterSubcommand((builder) => builder.setName("sub").setDescription(...))
  public async sub(interaction: Command.ChatInputInteraction, options: Options) {
    // ...
  }
}
```

Commands with many subcommands split them into one class per file with
`@wolfstar/plugin-subcommands-advanced`, as `/subscriptions` does. The parent
declares the subcommand groups and keeps the autocomplete (which the plugin does
not route to children); each child registers itself onto the parent and
implements `chatInputRun`. Shared helpers live in a `#twitch/*` module — see
`src/lib/utilities/twitch/subscriptions.ts` — and the parent/group names come
from the constants exported there, so the parent's builder and the children's
decorators cannot drift apart.

```text
src/commands/subscriptions/
├── parent.ts          // @RegisterCommand + .addSubcommandGroup, extends Subcommand
└── twitch/
    └── add.ts         // @RegisterAsSubcommandGroup("subscriptions", "twitch", ...)
```

The Stars CLI injects the register entrypoint before `src/main.ts`, and
`subcommandsAdvanced.nameCommandsAutogenerated` keeps same-named files in
different groups from colliding in the command store.

A command that doesn't need subcommands at all — typically an
Administrator-gated command whose flow is an interactive menu rather than a
set of arguments, e.g. `/setup` (`src/commands/subscriptions/setup.ts`) —
skips the subcommand pattern entirely: it's a single `Command` class with
`@RegisterCommand`, deferring the reply and handing off to a
`buildXMenu(...)`-style helper (see `src/lib/utilities/setupMenu.ts`) whose
result is then driven by an `InteractionHandler` (see Interaction Handlers
above and Interaction Handler Structure below).

### Interaction Handler Structure

`InteractionHandler` pieces extend `InteractionHandler` from
`@wolfstar/http-framework` and are loaded from `src/interaction-handlers/`.
They receive the raw interaction plus the parsed `custom_id` value and decide
how to route it themselves — there is no per-action decorator, unlike
commands:

```typescript
import { InteractionHandler } from "@wolfstar/http-framework";

export class UserInteractionHandler extends InteractionHandler {
	public override async run(
		interaction: InteractionHandler.Interaction,
		customIdValue: unknown,
	) {
		// Re-check permissions here; the component can outlive the check the
		// invoking command made. Then branch on the decoded custom_id.
	}
}
```

### Listener Structure

Listeners extend `Listener` from `@wolfstar/http-framework`:

```typescript
export default class extends Listener {
	public async run(data: EventData) {
		// Handle event
	}
}
```

### API Route Structure

The auxiliary REST API (health checks, webhooks) is built on
`@wolfstar/plugin-api`, ported from `@sapphire/plugin-api` (used by sibling
project [Skyra](https://github.com/skyra-project/skyra/tree/main/src/routes)) —
a standalone `node:http` server independent from the Discord interactions
webhook. Routes are `Route` pieces loaded from `src/routes/`, with path and HTTP
method inferred from the file's location
(`src/routes/twitch/event_sub_verify.post.ts` →
`POST /twitch/event_sub_verify`). Matching Skyra's convention, the exported
class is always named `UserRoute` regardless of what the route does (the file
path is what identifies it), and any per-request state that must persist across
calls (e.g. a dedup cache) is a private instance field, not a module-level
variable — one `Route` instance is a long-lived singleton:

```typescript
import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { Route } from "@wolfstar/plugin-api";

export class UserRoute extends Route {
	public run(request: ApiRequest, response: ApiResponse) {
		response.json({ ok: true });
	}
}
```

Cross-cutting concerns run as `Middleware` pieces loaded from
`src/middlewares/`, in ascending `position` order, configured declaratively
with the `@ApplyOptions` decorator now shipped by `@wolfstar/http-framework`
itself (previously a local `#utils/applyOptions` shim, needed because
`@sapphire/decorators`'s `ApplyOptions` requires `discord.js`, which this
http-interactions-only project doesn't depend on):

```typescript
import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { ApplyOptions } from "@wolfstar/http-framework";
import { Middleware } from "@wolfstar/plugin-api";

@ApplyOptions<Middleware.Options>({ position: 30 })
export class ExampleMiddleware extends Middleware {
	public run(request: ApiRequest, response: ApiResponse) {
		// Runs before route dispatch; end the response to short-circuit.
	}
}
```

## Development Commands

```bash
pnpm install              # Install dependencies
pnpm build                # Build through stars CLI + tsdown
pnpm start                # Start the application
pnpm dev                  # Build, watch and restart via stars CLI
TUNNEL=1 pnpm dev         # Same, plus a cloudflared tunnel (requires cloudflared)
pnpm watch                # Alias for the Stars development loop
pnpm lint                 # Run oxlint + oxfmt check
pnpm lint:fix             # Auto-fix lint issues (oxlint --fix + oxfmt)
pnpm prisma:generate      # Regenerate Prisma client after schema changes
pnpm i18n:generate        # Regenerate typed i18next declarations from locale JSON
pnpm test                 # Run the Vitest suite once (CI mode)
pnpm test:watch           # Run Vitest in watch mode
pnpm clean                # Remove build artifacts
pnpm update:interactive   # Update dependencies interactively via taze
```

## Pre-commit Checklist

Before committing changes, always run:

1. `pnpm build` - Must build successfully
2. `pnpm lint` - Fix any errors, warnings are acceptable
3. `pnpm test` - All tests must pass
4. Prisma client must be regenerated if schema changed

Commit messages must follow Conventional Commits: `<type>(<scope>): <subject>`

Types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `style`, `perf`,
`ci`, `build`

## Key Dependencies

- `@wolfstar/http-framework` - Discord HTTP interaction framework
- `@wolfstar/plugin-i18next` - i18next-powered internationalization plugin for
  the HTTP framework
- `@wolfstar/twitch-helpers` - Twitch EventSub types, helpers, and signature
  verification
- `@wolfstar/shared-http-pieces` - Shared command registration and Sentry
  integration
- `@sapphire/result` - Rust-like Result type for error handling
- `@sapphire/utilities` - General utilities (`cast`, `isNullish`,
  `isNullishOrEmpty`)
- `@sapphire/ratelimits` - Rate limiting
- `@sapphire/time-utilities` - Time constants (`Time.Minute`, etc.)
- `@discordjs/builders` - Discord embed and component builders
- `@wolfstar/plugin-logger` - Logger plugin providing `container.logger`
- `@prisma/client` - Database ORM
- `@wolfstar/plugin-api` - Standalone REST API server (`Route`/`Middleware`
  pieces) for health checks and Twitch EventSub webhooks
- `@wolfstar/plugin-subcommands-advanced` - Parent/child subcommand group
  pattern (`@RegisterAsSubcommandGroup`) for commands with enough subcommands to
  warrant one file each, e.g. `src/commands/subscriptions/`
- `vitest` - Test runner for unit/integration tests (`tests/`)
- `@wolfstar/http-framework-test-utils` - Test harness for dispatching fake
  Discord interactions through commands (`createTestHarness`,
  `httpFrameworkMatchers`)
- `@wolfstar/i18next-type-generator` - CLI used by `pnpm i18n:generate`
  (`stars codegen`) to generate the `src/@types/i18next.d.ts` resource
  augmentation from the locale JSON files

## Troubleshooting

- **Build issues:** Run `pnpm clean` then `pnpm build`
- **Prisma types stale:** Run `pnpm prisma:generate` after schema changes
- **i18next types stale or a translation key doesn't type-check:** Run
  `pnpm i18n:generate` after adding or changing locale JSON files under
  `src/locales/`
- **Twitch webhooks not working:** Verify webhook URL is accessible from the
  internet and HMAC signature verification is passing
- **Command not appearing:** Commands auto-register on startup via
  `@wolfstar/shared-http-pieces`; check Discord developer portal
- **New or changed command:** Add or update its test under `tests/commands/`
- **New or changed listener logic:** There is no listener test harness — extract
  the logic into a `#utils/*` module and add/update its test under
  `tests/utilities/`
- **New or changed interaction handler:** Extract the branching logic it calls
  into a testable `#utils/*` / `#twitch/*` module, same as listeners — see
  `src/lib/utilities/setupMenu.ts` / `tests/utilities/setupMenu.test.ts`

**When in doubt:** Copy existing patterns from similar files (e.g.,
`src/listeners/twitch/`, `src/commands/`) before inventing new ones.
