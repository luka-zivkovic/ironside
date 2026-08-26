# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ironside/shared build
RUN pnpm --filter @ironside/web build

# nginx serves the built static SPA and proxies /api and /health to the
# api container — the SAME same-origin contract apps/web/vite.config.ts's
# dev proxy already establishes, so the app's fetch calls (relative paths,
# no VITE_API_URL needed) work identically in dev and in this container
# without baking a host-specific API URL into the static bundle at build
# time (Vite env vars are compile-time, not runtime-configurable).
FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
