# Contributing to Staryl

Thank you for your interest in contributing! This document provides guidelines
and instructions for contributing.

> **Important** Please be respectful and constructive in all interactions. We
> aim to maintain a welcoming environment for all contributors.

## Goals

The goal of Staryl is to build a fast, reliable, and open-source Discord
notification bot that integrates with Twitch EventSub, prioritizing stability,
speed, and a clean developer experience.

### Core values

- Stability and reliability
- Type safety and code quality
- Speed and performance

### Target audience

Staryl is built for Discord server administrators who want real-time Twitch
stream notifications in their servers.

## Table of Contents

- [Getting started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Setup](#setup)
- [Development workflow](#development-workflow)
  - [Available commands](#available-commands)
  - [Project structure](#project-structure)
- [Code style](#code-style)
  - [TypeScript](#typescript)
  - [API route patterns](#api-route-patterns)
  - [Naming conventions](#naming-conventions)
  - [Database changes](#database-changes)
- [Submitting changes](#submitting-changes)
  - [Before submitting](#before-submitting)
  - [Pull request process](#pull-request-process)
  - [Commit messages and PR titles](#commit-messages-and-pr-titles)
  - [PR descriptions](#pr-descriptions)
- [Pre-commit hooks](#pre-commit-hooks)
- [Using AI](#using-ai)
- [Questions?](#questions)
- [License](#license)

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+ (LTS)
- [pnpm](https://pnpm.io/) 10+ (required -- not npm or yarn)
- [PostgreSQL](https://www.postgresql.org/) 14+
- [Redis](https://redis.io/)
- [Discord Application](https://discord.com/developers/applications/) (for bot
  token)
- [Twitch Application](https://dev.twitch.tv/console/apps) (for EventSub)

### Setup

1. Fork and clone the repository

   ```bash
   git clone https://github.com/wolfstar-project/staryl.git
   cd staryl
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Set up environment variables

   Create `src/.env` and configure:

   Required variables:
   - `DATABASE_URL` -- PostgreSQL connection string
   - `REDIS_HOST` -- Redis server host
   - `TWITCH_CLIENT_ID` -- Twitch application client ID
   - `TWITCH_CLIENT_SECRET` -- Twitch application secret
   - `HTTP_ADDRESS` -- Server bind address (default: `0.0.0.0`)
   - `HTTP_PORT` -- Server port (default: `3000`)
   - `API_ADDRESS` -- API server bind address (default: `0.0.0.0`)
   - `API_PORT` -- API server port (default: `3001`)

4. Set up the database:

   ```bash
   pnpm prisma:generate    # Generate Prisma client
   ```

5. Build and start:

   ```bash
   pnpm dev                # Build + start
   ```

## Development workflow

### Available commands

```bash
# Development
pnpm build                # Build TypeScript via tsdown
pnpm start                # Start the application
pnpm dev                  # Build + start
pnpm watch                # Watch mode for development

# Code Quality
pnpm lint                 # Run oxlint + oxfmt check
pnpm lint:fix             # Auto-fix lint issues (oxlint --fix + oxfmt)

# Database
pnpm prisma:generate      # Regenerate Prisma client after schema changes

# Maintenance
pnpm clean                # Remove build artifacts
pnpm update:interactive   # Update dependencies interactively via taze
```

### Project structure

```text
src/
├── main.ts                     # Application entry point
├── api/
│   └── routes/                 # HTTP API endpoints
│       └── twitch/             # Twitch EventSub webhook handlers
├── commands/                   # Discord slash commands (decorator pattern)
├── listeners/                  # Event listeners
│   └── twitch/                 # Twitch stream event listeners
├── lib/
│   ├── common/                 # Shared constants, error handling, promises
│   ├── i18n/                   # Internationalization keys
│   │   └── languageKeys/       # Language key definitions (nested objects)
│   ├── schedules/              # Schedule base classes
│   ├── setup/                  # Application initialization (env, Fastify, Prisma, logger)
│   ├── structures/             # Core classes (ScheduleHandler, stores)
│   ├── types/                  # TypeScript type definitions and enums
│   └── utilities/              # Helper functions (Discord API, Twitch, mentions)
└── locales/                    # Translation JSON files organized by locale

prisma/
└── schema.prisma               # Database schema
```

## Code style

When committing changes, try to keep an eye out for unintended formatting
updates. These can make a pull request look noisier than it really is and slow
down the review process.

The project uses `oxfmt` to handle formatting via a pre-commit hook. The hook
will automatically reformat files when needed. If you want to get ahead of any
formatting issues, run `pnpm lint:fix` before committing.

### TypeScript

- We care about good types -- never cast things to `any`; use `cast<T>()` from
  `@sapphire/utilities` when narrowing is needed
- Use strict mode and validate rather than just assert
- Use `@sapphire/result` for fallible operations instead of raw try/catch
- Use `const enum` for internal-only enumerations (prefixed with
  `oxlint-disable-next-line no-restricted-syntax`)
- Use standard `enum` for values that cross module boundaries or are used in
  Prisma
- Use `type` imports for type-only values: `import type { ... } from "..."`
- Use path mapping aliases for internal imports: `#lib/*`, `#api/*`, `#utils/*`,
  `#common/*`, `#i18n`
- Group imports: type imports first, then internal aliases, then external
  packages

### API route patterns

Routes are registered directly on `container.server` (Fastify). Always verify
Twitch EventSub signatures and validate request bodies:

```typescript
container.server.route({
  url: "/twitch/endpoint",
  method: "POST",
  handler: async (request, reply) => {
    // Verify signature, validate body, handle event
  },
});
```

### Naming conventions

| Type             | Convention      | Example                                     |
| ---------------- | --------------- | ------------------------------------------- |
| Directories      | kebab-case      | `language-keys/`                            |
| TypeScript files | camelCase       | `twitchStreamOnline.ts`                     |
| Variables        | camelCase       | `guildId`, `streamerId`                     |
| Constants        | PascalCase enum | `Colors.Amber`, `Events.TwitchStreamOnline` |
| Path constants   | PascalCase      | `PathRoot`, `PathSrc`                       |
| Types/Interfaces | PascalCase      | `GuildSubscription`                         |
| Classes          | PascalCase      | `ScheduleHandler`, `UserCommand`            |
| Enum members     | PascalCase      | `TwitchStreamStatus.Online`                 |
| Private methods  | `#`-prefixed    | `this.#getStreamer()`                       |

### Database changes

After modifying `prisma/schema.prisma`, always regenerate the Prisma client:

```bash
pnpm prisma:generate
```

Models use `@@map()` for snake_case table names and `@map()` for snake_case
column names. Always commit schema changes alongside the regenerated client.

## Submitting changes

### Before submitting

1. Ensure your code follows the style guidelines
2. Run linting: `pnpm lint:fix`
3. Validate the build: `pnpm build`
4. Regenerate Prisma client if schema changed: `pnpm prisma:generate`

### Pull request process

1. Create a feature branch from `main`
2. Make your changes with clear, descriptive commits
3. Push your branch and open a pull request
4. Ensure CI checks pass (lint, build)
5. Request review from maintainers

### Commit messages and PR titles

Write clear, concise PR titles that explain the "why" behind changes.

We use [Conventional Commits](https://www.conventionalcommits.org/). Since we
squash on merge, the PR title becomes the commit message in `main`, so it is
important to get it right.

Format: `type(scope): description`

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`, `types`

Scopes (optional): `twitch`, `commands`, `api`, `db`, `i18n`, `deps`

Examples:

- `feat(twitch): add stream offline notification embeds`
- `fix(commands): resolve subscription duplicate check`
- `docs: update installation instructions`
- `chore(deps): update @skyra/http-framework`

> **Note** Use lowercase letters in your pull request title. Individual commit
> messages within your PR don't need to follow this format since they'll be
> squashed.

### PR descriptions

If your pull request directly addresses an open issue, use the following inside
your PR description:

```text
Fixes #123
```

or

```text
Closes https://github.com/wolfstar-project/staryl/issues/123
```

This links the pull request to the issue and automatically closes it when the PR
is merged.

## Pre-commit hooks

Git hooks are managed via Husky. The `pre-commit` hook runs `nano-staged` to
automatically lint and format staged files before a commit. Commit messages are
validated against the Conventional Commits format by `commitlint`.

## Using AI

You're welcome to use AI tools to help you contribute. But there are two
important ground rules:

### 1. Never let an LLM speak for you

When you write a comment, issue, or PR description, use your own words. Grammar
and spelling don't matter -- real connection does. AI-generated summaries tend
to be long-winded, dense, and often inaccurate. The goal is not to sound
impressive, but to communicate clearly.

### 2. Never let an LLM think for you

Feel free to use AI to write code, tests, or point you in the right direction.
But always understand what it has written before contributing it. Take personal
responsibility for your contributions. Don't say "ChatGPT says..." -- tell us
what you think.

For more context, see
[Using AI in open source](https://roe.dev/blog/using-ai-in-open-source).

## Questions?

If you have questions or need help, feel free to
[open an issue](https://github.com/wolfstar-project/staryl/issues) for
discussion.

## License

By contributing to Staryl, you agree that your contributions will be licensed
under the [Apache License 2.0](../LICENSE).
