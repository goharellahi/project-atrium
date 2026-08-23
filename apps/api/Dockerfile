# syntax=docker/dockerfile:1
FROM node:26-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

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

FROM base AS runtime
WORKDIR /repo/apps/api
ENV NODE_ENV=production
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/api/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json
EXPOSE 3001
CMD ["node", "dist/main.js"]
