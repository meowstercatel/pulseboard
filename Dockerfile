# syntax=docker/dockerfile:1

ARG NODE_VERSION=24

# ---- deps: workspace manifests, shared by every stage that installs ----
# pnpm (version pinned by packageManager in package.json) comes from corepack.
FROM node:${NODE_VERSION}-alpine AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# ---- frontend: build the static Astro site ----
FROM base AS frontend
RUN pnpm install --frozen-lockfile --filter frontend
COPY frontend/ frontend/
# read at build time: upload limits and forecast thresholds for the pages, and
# the sample CSVs offered on /samples
COPY backend/src/datasets/limits.ts backend/src/datasets/
COPY backend/src/forecast/ backend/src/forecast/
COPY samples/*.csv samples/
# shown in the corner on non-main deployments, see BuildBadge.astro
ARG GIT_BRANCH=
ARG GIT_COMMIT=
ENV PUBLIC_GIT_BRANCH=$GIT_BRANCH \
    PUBLIC_GIT_COMMIT=$GIT_COMMIT
RUN pnpm --dir frontend run build

# ---- backend: install all deps and compile TypeScript ----
# This stage also keeps the Prisma CLI and backend/migrations, so docker compose
# uses it to run `prisma db migrate`.
FROM base AS backend
RUN pnpm install --frozen-lockfile --filter backend
COPY backend/ backend/
WORKDIR /app/backend
RUN pnpm run build

# ---- runtime: production deps + compiled backend + built frontend ----
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_DIR=/app/public
RUN pnpm install --frozen-lockfile --prod --filter backend && pnpm store prune
COPY --from=backend /app/backend/dist backend/dist
COPY --from=frontend /app/frontend/dist public
WORKDIR /app/backend
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
