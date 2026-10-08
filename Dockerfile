# Multi-stage Dockerfile for Interval Quiz Portal (IIT Ropar sAIDE)
FROM node:24-alpine AS builder

WORKDIR /app
RUN corepack enable

# Copy root and workspace manifests (+ lockfile) for cached install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# Install dependencies across all workspaces
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build API & Web packages
RUN pnpm run build

# Production runner stage
FROM node:24-alpine AS runner

WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
ENV PORT=4000
ENV INTERVAL_DATA_DIR=/app/data
# More libuv threads so a whole class signing in at once hashes passwords in parallel.
ENV UV_THREADPOOL_SIZE=16

# Copy manifests and install production dependencies only
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Expose API and frontend ports
EXPOSE 4000

# Create persistent data directory
RUN mkdir -p /app/data

HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# One process serves the API and the built web app (SQLite: run a single instance).
CMD ["node", "apps/api/dist/server.js"]
