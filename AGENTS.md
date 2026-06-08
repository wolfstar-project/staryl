# Agent Instructions

The authoritative agent guidance for this repository lives in
[.github/copilot-instructions.md](.github/copilot-instructions.md). All
planners, reviewers, and implementers must read that file first — it documents
the architecture, naming conventions, import aliases, command/listener patterns,
and the pre-commit checklist (`pnpm build`, `pnpm lint`, `pnpm prisma:generate`
when the schema changes).

## Quick reference

- Package manager: `pnpm`
- Build: `pnpm build` (tsdown / rolldown)
- Lint + format: `pnpm lint` (oxlint + oxfmt --check); auto-fix with
  `pnpm lint:fix`
- Prisma client output: `src/generated/prisma/` — regenerate with
  `pnpm prisma:generate`
- No Prisma `migrations/` directory exists; the schema is applied via
  `prisma db push` during development.
- Plans produced by **prometheus** are stored under `.atlas/plans/`.
- Conventional Commits are required.

## Cursor Cloud specific instructions

### Node.js

`package.json` requires **Node >= 24**. The VM default at `/exec-daemon/node` is
Node 22 — activate Node 24 before any `pnpm` command:

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 24
export PATH="$NVM_DIR/versions/node/v24.16.0/bin:$PATH"
```

### Infrastructure (PostgreSQL)

PostgreSQL is provided via Docker Compose. Docker is installed in the cloud VM
but requires `sudo` for socket access. Start the database (once per VM session):

```bash
sudo dockerd > /tmp/dockerd.log 2>&1 &   # only if docker daemon is not running
sudo docker compose -f compose.dev.yml up postgres -d
```

The compose file creates database **`staryl`** (not `starly` from the template
`src/.env`). Override in `src/.env.local` (gitignored):

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/staryl?schema=public"
```

Apply the schema after Postgres is healthy:

```bash
pnpm prisma:generate
pnpm exec prisma db push
```

Redis is listed in `compose.dev.yml` but is **not referenced in `src/`** today;
Postgres is the only required backing service for local dev.

### Environment variables

Copy `src/.env` values into `src/.env.local` for local overrides. The HTTP
framework requires non-empty `DISCORD_PUBLIC_KEY` and `DISCORD_TOKEN` to boot.
Without real Discord credentials, use placeholder values in `.env.local` and
start with:

```bash
NODE_OPTIONS='--unhandled-rejections=warn' pnpm start
```

`registerCommands()` will log a 401 from Discord but the process stays up in warn
mode. Real Discord/Twitch keys are needed for slash-command registration and
EventSub webhooks.

### Running the app

| Service | Port | Purpose |
| --- | --- | --- |
| Discord HTTP interactions | 3000 | Slash commands (`HTTP_PORT`) |
| Fastify API | 3001 | Twitch EventSub + health route (`API_PORT`) |

```bash
pnpm dev          # build + start (watch: pnpm watch with pnpm start)
pnpm lint         # oxlint + oxfmt
pnpm build        # tsdown build (CI also runs prisma:generate first)
```

Quick smoke test once running:

```bash
curl http://localhost:3001/          # {"data":"Hello world"}
curl -X POST http://localhost:3001/twitch/event_sub_verify  # 400 without Twitch headers
```

There is **no automated test suite**; CI runs `pnpm lint` and `pnpm build` only.
