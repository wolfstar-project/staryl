# syntax=docker/dockerfile:1.23

# ================ #
#   Base Stage     #
# ================ #

FROM node:24-alpine AS base

WORKDIR /usr/src/app

ENV CI="true"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV LOG_LEVEL=info
ENV FORCE_COLOR=true

RUN apk add --no-cache dumb-init g++ make python3
RUN corepack enable

COPY --chown=node:node pnpm-lock.yaml .
COPY --chown=node:node pnpm-workspace.yaml .
COPY --chown=node:node package.json .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

ENTRYPOINT ["dumb-init", "--"]

# ================ #
#   Builder Stage  #
# ================ #

FROM base AS builder

ENV NODE_ENV="development"

COPY --chown=node:node prisma/ prisma/
COPY --chown=node:node prisma.config.ts prisma.config.ts
COPY --chown=node:node src/ src/
COPY --chown=node:node tsconfig.base.json tsconfig.base.json
COPY --chown=node:node tsdown.config.ts tsdown.config.ts

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile \
    && pnpm run prisma:generate \
    && pnpm run build

# ================ #
#   Runner Stage   #
# ================ #

FROM base AS runner

ENV NODE_ENV="production"
ENV NODE_OPTIONS="--enable-source-maps --max_old_space_size=4096"

WORKDIR /usr/src/app

COPY --chown=node:node --from=builder /usr/src/app/dist dist
COPY --chown=node:node --from=builder /usr/src/app/src/.env src/.env

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

USER node

CMD [ "pnpm", "run", "start" ]
