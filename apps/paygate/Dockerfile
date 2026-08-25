# syntax=docker/dockerfile:1
FROM node:26-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# node:26-alpine no longer ships corepack — it was removed from the Node
# distribution. Install the pinned pnpm directly.
RUN npm install -g pnpm@10.33.0

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY apps/paygate/package.json ./apps/paygate/
RUN pnpm install --filter @atrium/paygate --frozen-lockfile=false

FROM base AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/paygate/node_modules ./apps/paygate/node_modules
COPY tsconfig.base.json pnpm-workspace.yaml package.json ./
COPY apps/paygate ./apps/paygate
WORKDIR /repo/apps/paygate
RUN pnpm build
# tsc emits .js only. The ledger's migration runner resolves .sql files relative
# to its own location, so they have to be carried across explicitly — the same
# line, for the same reason, as apps/api/Dockerfile.
RUN cp -r src/ledger/migrations dist/ledger/migrations

FROM base AS runtime
WORKDIR /repo/apps/paygate
ENV NODE_ENV=production
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/paygate/node_modules ./node_modules
COPY --from=build /repo/apps/paygate/dist ./dist
COPY --from=build /repo/apps/paygate/package.json ./package.json
EXPOSE 9000
CMD ["node", "dist/server.js"]
