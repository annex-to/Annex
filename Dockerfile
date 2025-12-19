# syntax=docker/dockerfile:1.4
# Annex Docker Image
# Multi-mode deployment: all-in-one, external DB, or external encoders

# =============================================================================
# Stage 1: Build
# =============================================================================
FROM oven/bun:1 AS builder

# Install build tools for native dependencies (including Node.js for node-gyp headers)
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    make \
    g++ \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files for dependency installation
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/encoder/package.json packages/encoder/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build all packages (server builds first to generate Prisma types)
RUN bun run build

# Note: Skipping production-only install to preserve generated Prisma Client
# This increases image size but ensures all generated types are available

# =============================================================================
# Stage 2: Runtime
# =============================================================================
FROM oven/bun:1-slim AS runtime

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql \
    postgresql-contrib \
    ffmpeg \
    nginx \
    procps \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create app user
RUN useradd --system --create-home --shell /bin/bash annex

WORKDIR /app

# Copy built artifacts from builder
COPY --from=builder /app/packages ./packages/
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json ./package.json

# Copy entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Configure nginx for static files + API proxy
RUN rm /etc/nginx/sites-enabled/default
COPY <<'EOF' /etc/nginx/sites-available/annex
server {
    listen 80;
    server_name _;

    # Client static files
    root /app/packages/client/dist;
    index index.html;

    # API and WebSocket proxy
    location /trpc {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Encoder WebSocket
    location /encoder {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # API routes
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Deploy encoder route
    location /deploy-encoder {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
}
EOF
RUN ln -s /etc/nginx/sites-available/annex /etc/nginx/sites-enabled/annex

# Create data directories
RUN mkdir -p /data/postgres /data/config /downloads \
    && chown -R postgres:postgres /data/postgres \
    && chown -R annex:annex /data/config /downloads

# Environment defaults
ENV PORT=3000
ENV NODE_ENV=production
ENV ANNEX_CONFIG_DIR=/data/config

# Expose port
EXPOSE 80

# Volumes for persistent data
VOLUME ["/data/postgres", "/data/config", "/downloads"]

# Entrypoint
ENTRYPOINT ["/docker-entrypoint.sh"]
