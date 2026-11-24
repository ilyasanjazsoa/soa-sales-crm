# One image for the api (which also serves the built web app), the worker and the migration task (§16).
# ECS picks the role with the command: api (default), worker, or migrate.
FROM node:22.20-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.18.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @soa/web build

FROM node:22.20-bookworm-slim
ENV NODE_ENV=production WEB_DIST_DIR=/app/apps/web/dist
WORKDIR /app
RUN useradd --system --uid 10001 crm
COPY --from=build --chown=crm:crm /app /app
USER crm
EXPOSE 3000
# api: the web app and /api. worker: the background jobs. migrate: run before a new version starts.
ENTRYPOINT ["sh", "-c", "case \"${1:-api}\" in api) cd apps/api && exec node --import tsx src/main.ts ;; worker) cd apps/worker && exec node --import tsx src/main.ts ;; migrate) cd packages/db && exec node --import tsx scripts/migrate.ts ;; *) echo \"unknown role $1\" >&2; exit 2 ;; esac", "--"]
CMD ["api"]
