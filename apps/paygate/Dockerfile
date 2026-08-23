# syntax=docker/dockerfile:1
FROM node:26-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

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

FROM base AS runtime
WORKDIR /repo/apps/paygate
ENV NODE_ENV=production
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/paygate/node_modules ./node_modules
COPY --from=build /repo/apps/paygate/dist ./dist
COPY --from=build /repo/apps/paygate/package.json ./package.json
EXPOSE 9000
CMD ["node", "dist/server.js"]
