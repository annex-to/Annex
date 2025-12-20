#!/bin/bash
set -e

# Annex Docker Entrypoint
# Supports three modes:
# 1. All-in-one (default): Internal Postgres + server + internal encoder
# 2. External Postgres: Set DATABASE_URL to use external database
# 3. External encoders: Set DISABLE_INTERNAL_ENCODER=true

USE_INTERNAL_POSTGRES=true
USE_INTERNAL_ENCODER=true

# Add PostgreSQL binaries to PATH
PG_VERSION=$(ls /usr/lib/postgresql/ | head -n 1)
export PATH="/usr/lib/postgresql/${PG_VERSION}/bin:$PATH"

# Check for external database
if [ -n "$DATABASE_URL" ]; then
  echo "[Annex] Using external PostgreSQL"
  USE_INTERNAL_POSTGRES=false
fi

# Check for encoder disable flag
if [ "$DISABLE_INTERNAL_ENCODER" = "true" ]; then
  echo "[Annex] Internal encoder disabled"
  USE_INTERNAL_ENCODER=false
fi

# Start internal Postgres if needed
if [ "$USE_INTERNAL_POSTGRES" = "true" ]; then
  echo "[Annex] Starting internal PostgreSQL..."

  PGDATA=/data/postgres

  # Initialize database if needed
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "[Annex] Initializing PostgreSQL data directory..."
    mkdir -p "$PGDATA"
    chown -R postgres:postgres "$PGDATA"
    su postgres -c "initdb -D $PGDATA"

    # Configure to allow local connections
    echo "local all all trust" > "$PGDATA/pg_hba.conf"
    echo "host all all 127.0.0.1/32 trust" >> "$PGDATA/pg_hba.conf"
  fi

  # Start PostgreSQL
  su postgres -c "pg_ctl -D $PGDATA -l $PGDATA/logfile start -w"

  # Create database if it doesn't exist
  if ! su postgres -c "psql -lqt" | cut -d \| -f 1 | grep -qw annex; then
    echo "[Annex] Creating annex database..."
    su postgres -c "createdb annex"
  fi

  export DATABASE_URL="postgresql://postgres@localhost/annex"
fi

# Set config directory
export ANNEX_CONFIG_DIR="${ANNEX_CONFIG_DIR:-/data/config}"
mkdir -p "$ANNEX_CONFIG_DIR"

# Run database migrations
echo "[Annex] Running database migrations..."
cd /app/packages/server
bunx prisma@6.19.1 migrate deploy --schema=./prisma/schema.prisma

# Start internal encoder in background if enabled
if [ "$USE_INTERNAL_ENCODER" = "true" ]; then
  echo "[Annex] Starting internal encoder..."

  # Configure encoder connection (connect to internal server port)
  export ANNEX_SERVER_URL="ws://localhost:${PORT}/encoder"
  export ANNEX_ENCODER_ID="${ENCODER_ID:-internal}"
  export ANNEX_ENCODER_NAME="${ENCODER_NAME:-Docker Internal}"
  export ANNEX_NFS_BASE_PATH="${ENCODER_DOWNLOADS_PATH:-/downloads}"

  # Detect GPU availability
  if [ -e "/dev/dri/renderD128" ]; then
    echo "[Annex] GPU detected at /dev/dri/renderD128"
    export ANNEX_GPU_DEVICE="/dev/dri/renderD128"
  else
    echo "[Annex] No GPU detected, encoder will use CPU (libsvtav1)"
  fi

  # Start encoder with auto-restart in background (detached session)
  setsid bash -c '
    while true; do
      echo "[Encoder Supervisor] Starting encoder at $(date)"
      /usr/local/bin/annex-encoder
      EXIT_CODE=$?
      echo "[Encoder Supervisor] Encoder exited with code $EXIT_CODE at $(date), restarting in 5 seconds..."
      sleep 5
    done
  ' > /var/log/encoder.log 2>&1 &
  ENCODER_PID=$!
  echo "[Annex] Internal encoder supervisor started (PID: $ENCODER_PID)"
fi

# Start nginx for static files
echo "[Annex] Starting nginx on port 80..."
nginx

# Handle shutdown gracefully
cleanup() {
  echo "[Annex] Shutting down..."

  nginx -s quit 2>/dev/null || true

  if [ -n "$ENCODER_PID" ]; then
    kill $ENCODER_PID 2>/dev/null || true
  fi

  if [ "$USE_INTERNAL_POSTGRES" = "true" ]; then
    su postgres -c "pg_ctl -D /data/postgres stop -m fast" 2>/dev/null || true
  fi

  exit 0
}

trap cleanup SIGTERM SIGINT

# Start server
echo "[Annex] Starting server on port ${PORT:-3000}..."
cd /app/packages/server
exec bun src/index.ts
