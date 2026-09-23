# Multi-stage Dockerfile for Interval Quiz Portal (IIT Ropar sAIDE)
FROM node:24-alpine AS builder

WORKDIR /app

# Copy root and workspace definitions
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY apps/web/package*.json ./apps/web/

# Install dependencies across all workspaces
RUN npm ci

# Copy source code
COPY . .

# Build API & Web packages
RUN npm run build

# Production runner stage
FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
ENV INTERVAL_DATA_DIR=/app/data

# Copy built artifacts and production dependencies
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY apps/web/package*.json ./apps/web/

RUN npm ci --omit=dev

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Expose API and frontend ports
EXPOSE 4000

# Create persistent data directory
RUN mkdir -p /app/data

CMD ["node", "apps/api/dist/server.js"]
