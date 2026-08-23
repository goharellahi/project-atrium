# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Atrium API. Multi-stage so the runtime image carries no compiler, no
# dev dependencies and no source.
#
# The same image is used for all three replicas AND for the one-shot migrate
# service, which is why the migrations are copied into dist.
# ---------------------------------------------------------------------------
FROM node:26-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# node:26-alpine no longer ships corepack — it was removed from the Node
# distribution. Install the pinned pnpm directly.
RUN npm install -g pnpm@10.33.0

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json ./apps/api/
RUN pnpm install --filter @atrium/api --frozen-lockfile=false

FROM base AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY tsconfig.base.json pnpm-workspace.yaml package.json ./
COPY apps/api ./apps/api
WORKDIR /repo/apps/api
RUN pnpm build
# tsc emits .js only. The migration runner resolves .sql files relative to its
# own location, so they have to be carried across explicitly.
RUN cp -r src/db/migrations dist/db/migrations

FROM base AS runtime
WORKDIR /repo/apps/api
ENV NODE_ENV=production
# Run unprivileged. The node image ships a `node` user; use it rather than root.
COPY --from=build --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=build --chown=node:node /repo/apps/api/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
