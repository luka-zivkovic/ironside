# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# --prod install runs on this Linux base, so npm/pnpm resolves the
# linux-x64 (or linux-arm64, matching the build platform)
# @duckdb/node-bindings-* optional dependency correctly — a native
# binding copied from a non-Linux host would not load.
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/db/dist ./packages/db/dist
COPY --from=build /repo/packages/clickhouse/dist ./packages/clickhouse/dist
COPY --from=build /repo/packages/queue/dist ./packages/queue/dist
COPY --from=build /repo/packages/storage/dist ./packages/storage/dist
COPY --from=build /repo/packages/mappers/dist ./packages/mappers/dist
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist

HEALTHCHECK --interval=30s --timeout=10s --retries=5 \
  CMD ["node", "-e", "const h=process.env.METRICS_TOKEN?{authorization:'Bearer '+process.env.METRICS_TOKEN}:{};fetch('http://127.0.0.1:'+(process.env.METRICS_PORT||9464)+'/metrics',{headers:h}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/worker/dist/src/index.js"]
