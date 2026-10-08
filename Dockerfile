# syntax=docker/dockerfile:1

ARG NODE_VERSION=24

# ---- frontend: build the static Astro site ----
FROM node:${NODE_VERSION}-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---- backend: install all deps and compile TypeScript ----
# This stage also keeps the Prisma CLI, so docker compose uses it to run `prisma db init`.
FROM node:${NODE_VERSION}-alpine AS backend
RUN corepack enable
WORKDIR /app/backend
COPY backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY backend/ ./
RUN pnpm run build

# ---- runtime: production deps + compiled backend + built frontend ----
FROM node:${NODE_VERSION}-alpine AS runtime
RUN corepack enable
ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_DIR=/app/public
WORKDIR /app
COPY backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY --from=backend /app/backend/dist ./dist
COPY --from=frontend /app/frontend/dist ./public
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
