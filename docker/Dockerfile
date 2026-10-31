# One image runs both the API server (default) and the worker (`node dist/worker.js`).

FROM node:24-alpine AS base
RUN npm install --global pnpm@12.3.4
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/flow/package.json packages/flow/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --recursive build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter @social-switchboard/server

FROM node:24-alpine AS runtime
# pg_dump for backups; must be at least the server's major version.
RUN apk add --no-cache postgresql18-client tini \
 && mkdir -p /backups && chown node:node /backups
ARG APP_VERSION=0.1.0
ENV NODE_ENV=production APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/server/node_modules ./apps/server/node_modules
COPY apps/server/package.json ./apps/server/
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY --from=build /repo/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /repo/apps/web/dist ./apps/web/dist
COPY docs/guides ./docs/guides
WORKDIR /app/apps/server
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
