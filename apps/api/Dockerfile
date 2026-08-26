# syntax=docker/dockerfile:1

# Builds the whole monorepo once (every package @ironside/api depends on
# via project references), then keeps only the built output + production
# node_modules in the final image — the full source tree and devDeps
# never ship.

FROM node:24-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# --frozen-lockfile: the image must build from exactly what's committed,
# never silently resolve newer versions than CI/dev tested against.
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# Same workspace file layout as the build stage (package.json files are
# what pnpm's install resolves against), but --prod skips devDependencies
# and this stage never runs tsc — dist/ is copied in from `build` below.
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/db/dist ./packages/db/dist
COPY --from=build /repo/packages/clickhouse/dist ./packages/clickhouse/dist
COPY --from=build /repo/packages/queue/dist ./packages/queue/dist
COPY --from=build /repo/packages/storage/dist ./packages/storage/dist
COPY --from=build /repo/packages/mappers/dist ./packages/mappers/dist
COPY --from=build /repo/apps/api/dist ./apps/api/dist

EXPOSE 8788
CMD ["node", "apps/api/dist/src/index.js"]
