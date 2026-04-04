# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this
repository.

## Project Overview

**Starly** is a Discord notification bot built with TypeScript that integrates
with Twitch EventSub to provide stream status notifications. It uses HTTP
interactions via Discord's HTTP-based bot architecture rather than a persistent
WebSocket connection.

### Technology Stack

- **Runtime**: Node.js 22+ with ESM modules
- **Language**: TypeScript with strict configuration
- **Framework**: Skyra HTTP Framework (Fastify-based)
- **Database**: PostgreSQL with Prisma ORM
- **Cache**: Redis
- **Package Manager**: pnpm (required, version 10+)
- **Container**: Docker with multi-stage builds

## Architecture Overview

### Core Components

1. **HTTP Framework**: Built on `@skyra/http-framework` which provides Discord
   slash command handling via HTTP endpoints instead of WebSocket gateway
2. **Database Layer**: Prisma-based with PostgreSQL for persistent storage of
   guild subscriptions and Twitch subscription mappings
3. **Event System**: Twitch EventSub webhook handling for stream online/offline
   notifications
4. **Internationalization**: Multi-language support via
   `@skyra/http-framework-i18n`

### Directory Structure

```
src/
├── main.ts                 # Application entry point
├── api/routes/            # HTTP API endpoints
│   └── twitch/            # Twitch EventSub webhook handlers
├── commands/              # Discord slash commands
├── listeners/             # Event listeners for Twitch events
├── lib/
│   ├── setup/            # Application initialization
│   ├── structures/       # Core classes (ScheduleHandler, etc.)
│   ├── utilities/        # Helper functions
│   ├── types/            # TypeScript type definitions
│   ├── i18n/             # Internationalization keys
│   └── common/           # Shared constants and utilities
└── locales/              # Translation files
```

### Key Architecture Patterns

- **Path Mapping**: Uses TypeScript path mapping with `#lib/*`, `#api/*`, etc.
  for clean imports
- **Command Structure**: Discord commands use decorators (`@RegisterCommand`,
  `@RegisterSubcommand`)
- **Event-Driven**: Twitch webhooks trigger internal events that listeners
  handle
- **Database Relations**: Guild subscriptions link Discord channels to Twitch
  stream subscriptions

## Development Commands

### Essential Commands

```bash
# Install dependencies
pnpm install

# Build TypeScript to JavaScript
pnpm build

# Start the application
pnpm start

# Development mode (build + start)
pnpm dev

# Watch mode for development
pnpm watch

# Generate Prisma client after schema changes
pnpm prisma:generate

# Clean build artifacts
pnpm clean
```

### Code Quality

```bash
# Lint code
pnpm lint

# Auto-fix linting issues
pnpm lint:fix

# Update dependencies interactively
pnpm update -i
```

### Database Operations

```bash
# Generate Prisma client
pnpm prisma:generate

# Run database migrations (if any)
npx prisma migrate deploy

# Access database CLI
npx prisma studio
```

## Development Environment

### Required Environment Variables

Create `src/.env` with:

- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_HOST`: Redis server host
- `TWITCH_CLIENT_ID`: Twitch application client ID
- `TWITCH_CLIENT_SECRET`: Twitch application secret
- `HTTP_ADDRESS`: Server bind address (default: localhost)
- `HTTP_PORT`: Server port (default: 3000)

### Docker Development

```bash
# Start all services (bot, postgres, redis)
docker-compose up -d

# View logs
docker-compose logs -f staryl

# Stop services
docker-compose down
```

## Testing and Single Command Execution

This project currently lacks a formal test suite. When adding tests:

- Use the existing TypeScript configuration
- Consider integration tests for command handlers
- Mock Discord API interactions and database calls

For testing individual commands during development:

- Use Discord's developer portal to test slash commands
- Monitor logs via `docker-compose logs -f staryl`
- Use database inspection via `npx prisma studio`

## Key Integration Points

### Twitch EventSub Integration

- Webhooks received at `/twitch/event_sub_verify`
- Supports `stream.online` and `stream.offline` events
- Signature verification ensures authentic Twitch payloads
- Events are mapped to internal event system

### Discord Slash Commands

- Commands defined in `src/commands/` with decorator pattern
- HTTP-based interactions (not WebSocket gateway)
- Automatic command registration via `@skyra/shared-http-pieces`
- Ephemeral responses for admin commands

### Database Schema Key Points

- `TwitchSubscription`: Maps streamer IDs to EventSub subscription IDs
- `GuildSubscription`: Links Discord guilds/channels to Twitch subscriptions
- Composite primary keys ensure uniqueness per guild/channel/subscription
- Supports custom notification messages

## Build and Deployment Notes

### Docker Considerations

- Uses Node 20 Alpine base image
- Multi-stage build separates dependencies from runtime
- **Important**: Dockerfile filename is misspelled as `Dockefile` (should be
  `Dockerfile`)
- Uses Yarn in Docker but pnpm locally - consider standardizing

### Production Deployment

- Requires PostgreSQL and Redis instances
- Environment variables must be configured
- Source maps enabled for debugging (`NODE_OPTIONS="--enable-source-maps"`)
- Runs as non-root user in container

## Debugging and Troubleshooting

### Common Issues

- **Command Registration**: Commands auto-register on startup; check Discord
  developer portal
- **Database Connection**: Ensure PostgreSQL is running and `DATABASE_URL` is
  correct
- **Twitch Webhooks**: Verify webhook URL is accessible from internet and uses
  HTTPS in production
- **Prisma Client**: Run `pnpm prisma:generate` after schema changes

### Development Tips

- Use `pnpm watch` for automatic rebuilds during development
- Monitor container logs for runtime issues
- Prisma Studio provides GUI for database inspection
- EventSub events can be tested using Twitch CLI or webhook testing tools
