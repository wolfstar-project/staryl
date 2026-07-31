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
  `@RegisterSubcommand`) for Discord slash commands
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
| Directories      | kebab-case      | `language-keys/`                                       |
| TypeScript files | camelCase       | `twitchStreamOnline.ts`                                |
| Variables        | camelCase       | `guildId`, `streamerId`                                |
| Constants        | PascalCase enum | `Colors.Amber`, `Events.TwitchStreamOnline`            |
| Path constants   | PascalCase      | `PathRoot`, `PathSrc`                                  |
| Types/Interfaces | PascalCase      | `GuildSubscription`, `DetailedMentionExtractionResult` |
| Classes          | PascalCase      | `ScheduleHandler`, `UserCommand`                       |
| Enum members     | PascalCase      | `TwitchStreamStatus.Online`                            |
| Private methods  | `#`-prefixed    | `this.#getStreamer()`                                  |

## Import Conventions

- Use TypeScript path mapping aliases for internal imports: `#lib/*`,
  `#utils/*`, `#common/*`, `#i18n`
- Use `type` imports for type-only values: `import type { ... } from "..."`
- Group imports: type imports first, then internal aliases, then external
  packages
- Prefer importing from barrel files (`#lib/types`, `#i18n/languageKeys`) over
  deep paths

## Project Architecture

### Key Patterns

- **HTTP Framework**: Built on `@wolfstar/http-framework`, handling Discord
  interactions via HTTP endpoints instead of WebSocket gateway
- **Database**: PostgreSQL with Prisma ORM. Models use `@@map()` for snake_case
  table names, `@map()` for snake_case column names
- **Event System**: Twitch EventSub webhooks trigger internal events
  (`Events.TwitchStreamOnline`, `Events.TwitchStreamOffline`) that listeners
  handle
- **i18n**: Multi-language support via `@wolfstar/http-framework-i18n` with
  language keys defined as nested objects in `src/lib/i18n/languageKeys/`
- **Rate Limiting**: Use `@sapphire/ratelimits` `RateLimitManager` for
  notification drip control
- **Scheduling**: Custom `ScheduleHandler` piece extending
  `@wolfstar/http-framework`'s `Piece` class

### Directory Structure

- `src/main.ts` - Application entry point
- `src/routes/` - HTTP API endpoints (`@wolfstar/plugin-api` `Route` pieces,
  e.g. Twitch EventSub webhooks)
- `src/middlewares/` - HTTP API middlewares (`@wolfstar/plugin-api` `Middleware`
  pieces)
- `src/commands/` - Discord slash commands using decorator pattern
- `src/listeners/` - Event listeners for Twitch stream events
- `src/lib/setup/` - Application initialization (env, Prisma, logger, schedules)
- `src/lib/structures/` - Core classes (`ScheduleHandler`, stores)
- `src/lib/utilities/` - Helper functions (Discord API, Twitch, mention parsing)
- `src/lib/common/` - Shared constants, error handling, promise utilities
- `src/lib/types/` - TypeScript type definitions and enums
- `src/lib/i18n/` - Internationalization keys and definitions
- `src/locales/` - Translation JSON files organized by locale
- `prisma/schema.prisma` - Database schema
- `tests/` - Vitest test suite, organized by area
  (`tests/commands/twitchsubscriptions.test.ts` tests
  `src/commands/twitchsubscriptions.ts`); `tests/setup.ts` registers the
  `@wolfstar/http-framework-test-utils` matchers and boots i18n

### Command Structure

Commands use the decorator pattern from `@wolfstar/http-framework`:

```typescript
@RegisterCommand((builder) =>
  builder
    .setName("command-name")
    .setDescription(LanguageKeys.Commands.Namespace.Description)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
)
export class UserCommand extends Command {
  @RegisterSubcommand((builder) => builder.setName("sub").setDescription(...))
  public async sub(interaction: Command.ChatInputInteraction, options: Options) {
    // ...
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
`src/middlewares/`, in ascending `position` order, configured declaratively with
the local `@ApplyOptions` decorator (`#utils/applyOptions` — a minimal
equivalent of `@sapphire/decorators`'s `ApplyOptions`; that package can't be
used here since its bundled entrypoint requires `discord.js`, which this
http-interactions-only project doesn't depend on):

```typescript
import type { ApiRequest, ApiResponse } from "@wolfstar/plugin-api";
import { ApplyOptions } from "#utils/applyOptions";
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
pnpm build                # Build TypeScript via tsdown
pnpm start                # Start the application
pnpm dev                  # Build + start
pnpm watch                # Watch mode for development
pnpm lint                 # Run oxlint + oxfmt check
pnpm lint:fix             # Auto-fix lint issues (oxlint --fix + oxfmt)
pnpm prisma:generate      # Regenerate Prisma client after schema changes
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
- `@wolfstar/http-framework-i18n` - Internationalization for the HTTP framework
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
- `@prisma/client` - Database ORM
- `ioredis` - Redis client
- `@wolfstar/plugin-api` - Standalone REST API server (`Route`/`Middleware`
  pieces) for health checks and Twitch EventSub webhooks
- `vitest` - Test runner for unit/integration tests (`tests/`)
- `@wolfstar/http-framework-test-utils` - Test harness for dispatching fake
  Discord interactions through commands (`createTestHarness`,
  `httpFrameworkMatchers`)

## Troubleshooting

- **Build issues:** Run `pnpm clean` then `pnpm build`
- **Prisma types stale:** Run `pnpm prisma:generate` after schema changes
- **Twitch webhooks not working:** Verify webhook URL is accessible from the
  internet and HMAC signature verification is passing
- **Command not appearing:** Commands auto-register on startup via
  `@wolfstar/shared-http-pieces`; check Discord developer portal
- **New or changed command:** Add or update its test under `tests/commands/`

**When in doubt:** Copy existing patterns from similar files (e.g.,
`src/listeners/twitch/`, `src/commands/`) before inventing new ones.
