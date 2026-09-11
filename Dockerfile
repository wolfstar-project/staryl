# syntax=docker/dockerfile:1.27
#
# Multi-stage build following the official pnpm Docker guide
# (https://pnpm.io/it/docker#build-a-bundle-in-docker), adapted for this
# project (Prisma generate, native build deps, non-root runtime user).

# ================ #
#   Base Stage     #
# ================ #

FROM ghcr.io/pnpm/pnpm:12 AS base

RUN pnpm runtime set node 24 -g

ENV CI="true"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV LOG_LEVEL=info

RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

ENTRYPOINT ["dumb-init", "--"]

# ================ #
#  Prod Deps Stage #
# ================ #

FROM base AS prod-deps

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

# ================ #
#   Build Stage    #
# ================ #

FROM base AS build

ENV NODE_ENV="development"

COPY prisma/ prisma/
COPY prisma.config.ts prisma.config.ts
COPY scripts/ scripts/
COPY src/ src/
COPY tsconfig.base.json tsconfig.base.json
COPY stars.config.ts stars.config.ts

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile \
    && pnpm run prisma:generate \
    && pnpm run build

# ================ #
#   Runner Stage   #
# ================ #

FROM base AS runner

ENV NODE_ENV="production"
ENV NODE_OPTIONS="--enable-source-maps --max_old_space_size=4096"

RUN groupadd --system app \
    && useradd --system --gid app --home-dir /app app \
    && chown app:app /app

COPY --from=prod-deps --chown=app:app /app/node_modules node_modules
COPY --from=build --chown=app:app /app/dist dist
COPY --from=build --chown=app:app /app/src/.env src/.env

USER app

EXPOSE 3000 3001

CMD [ "pnpm", "start" ]
