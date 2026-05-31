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
