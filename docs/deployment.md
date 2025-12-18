# Annex Deployment Guide

This guide covers deploying Annex using Docker.

## Quick Start

Pull and run with zero configuration:

```bash
docker run -d \
  --name annex \
  -p 80:80 \
  -v annex-postgres:/data/postgres \
  -v annex-config:/data/config \
  -v /path/to/downloads:/downloads \
  ghcr.io/wehavenoeyes/annex:latest
```

Open `http://localhost` and complete the setup wizard.

## Available Tags

| Tag | Description |
|-----|-------------|
| `latest` | Latest stable release (manual deployment) |
| `canary` | Latest build from main branch (automated) |
| `x.y.z` | Specific version (e.g., `1.0.0`) |

## Deployment Modes

The Docker image supports three operational modes:

### 1. All-in-One (Default)

Runs everything internally: PostgreSQL, server, and encoder. No external dependencies required.

```bash
docker run -d \
  --name annex \
  -p 80:80 \
  -v annex-postgres:/data/postgres \
  -v annex-config:/data/config \
  -v /path/to/downloads:/downloads \
  ghcr.io/wehavenoeyes/annex:latest
```

### 2. External PostgreSQL

Use an external PostgreSQL database by setting `DATABASE_URL`:

```bash
docker run -d \
  --name annex \
  -p 80:80 \
  -e DATABASE_URL="postgresql://user:password@db-host:5432/annex" \
  -v annex-config:/data/config \
  -v /path/to/downloads:/downloads \
  ghcr.io/wehavenoeyes/annex:latest
```

The `/data/postgres` volume is not needed in this mode.

### 3. External Encoders Only

Disable the internal encoder when using dedicated encoder nodes:

```bash
docker run -d \
  --name annex \
  -p 80:80 \
  -e DISABLE_INTERNAL_ENCODER=true \
  -v annex-postgres:/data/postgres \
  -v annex-config:/data/config \
  ghcr.io/wehavenoeyes/annex:latest
```

## GPU Encoding

For hardware-accelerated AV1 encoding (Intel Arc), pass through the GPU device:

```bash
docker run -d \
  --name annex \
  -p 80:80 \
  --device=/dev/dri:/dev/dri \
  -v annex-postgres:/data/postgres \
  -v annex-config:/data/config \
  -v /path/to/downloads:/downloads \
  ghcr.io/wehavenoeyes/annex:latest
```

The encoder auto-detects GPU availability:
- **GPU present**: Uses VAAPI hardware encoding (av1_vaapi)
- **No GPU**: Falls back to CPU encoding (libsvtav1)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | (internal) | PostgreSQL connection string. If set, uses external database |
| `DISABLE_INTERNAL_ENCODER` | `false` | Set to `true` to disable internal encoder |
| `ENCODER_ID` | `internal` | Identifier for the internal encoder |
| `ENCODER_NAME` | `Docker Internal` | Display name for the internal encoder |
| `ENCODER_DOWNLOADS_PATH` | `/downloads` | Path where encoder accesses download files |

All other configuration (TMDB API key, qBittorrent, etc.) is done through the web UI setup wizard.

## Volumes

| Path | Purpose |
|------|---------|
| `/data/postgres` | PostgreSQL data directory (all-in-one mode only) |
| `/data/config` | Annex configuration (master encryption key, settings) |
| `/downloads` | Download directory shared with qBittorrent |

## Ports

| Port | Service |
|------|---------|
| 80 | Web UI and API (nginx) |

The internal server runs on port 3001, proxied by nginx.

## Docker Compose

Example `docker-compose.yml` for all-in-one deployment:

```yaml
version: "3.8"

services:
  annex:
    image: ghcr.io/wehavenoeyes/annex:latest
    container_name: annex
    ports:
      - "80:80"
    volumes:
      - annex-postgres:/data/postgres
      - annex-config:/data/config
      - /path/to/downloads:/downloads
    devices:
      - /dev/dri:/dev/dri  # Optional: GPU passthrough
    restart: unless-stopped

volumes:
  annex-postgres:
  annex-config:
```

Example with external PostgreSQL:

```yaml
version: "3.8"

services:
  annex:
    image: ghcr.io/wehavenoeyes/annex:latest
    container_name: annex
    ports:
      - "80:80"
    environment:
      - DATABASE_URL=postgresql://annex:password@postgres:5432/annex
      - DISABLE_INTERNAL_ENCODER=true
    volumes:
      - annex-config:/data/config
      - /path/to/downloads:/downloads
    depends_on:
      - postgres
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    container_name: annex-postgres
    environment:
      - POSTGRES_USER=annex
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=annex
    volumes:
      - postgres-data:/var/lib/postgresql/data
    restart: unless-stopped

volumes:
  annex-config:
  postgres-data:
```

## Building the Image

To build the Docker image locally:

```bash
git clone https://github.com/WeHaveNoEyes/Annex.git
cd Annex
docker build -t annex .
```

## External Encoder Nodes

For distributed encoding, deploy encoder nodes on separate machines. Encoders are distributed as standalone executables (no Bun runtime required).

**Migrating from old encoder?** See [Encoder Migration Guide](encoder-migration.md) for upgrade instructions.

### Quick Setup

**Linux:**
```bash
# Download the binary
curl -L https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-linux-x64 -o annex-encoder
chmod +x annex-encoder

# Setup and install systemd service
sudo ./annex-encoder --setup --install

# Edit configuration
sudo nano /etc/annex-encoder.env
# Set ANNEX_SERVER_URL=ws://annex-server:80/encoder
# Set ANNEX_ENCODER_ID=encoder-1
# Set ANNEX_NFS_BASE_PATH=/mnt/downloads

# Start the service
sudo systemctl start annex-encoder
sudo systemctl status annex-encoder
```

**Windows (run PowerShell as Administrator):**
```powershell
# Download the binary
Invoke-WebRequest -Uri "https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-windows-x64.exe" -OutFile "annex-encoder.exe"

# Setup and install Windows service
.\annex-encoder.exe --setup --install

# Edit environment variables in System Properties or modify the service

# Start the service
Start-Service AnnexEncoder
Get-Service AnnexEncoder
```

**macOS:**
```bash
# Download the binary (use darwin-arm64 for Apple Silicon, darwin-x64 for Intel)
curl -L https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-darwin-arm64 -o annex-encoder
chmod +x annex-encoder

# Setup and install launchd service
./annex-encoder --setup --install

# Edit configuration
nano ~/Library/LaunchAgents/com.annex.encoder.plist

# Start the service
launchctl start com.annex.encoder
```

### Configuration

All platforms use environment variables for configuration:

| Variable | Description | Example |
|----------|-------------|---------|
| `ANNEX_SERVER_URL` | WebSocket URL to Annex server | `ws://192.168.1.50:80/encoder` |
| `ANNEX_ENCODER_ID` | Unique identifier for this encoder | `encoder-1` |
| `ANNEX_GPU_DEVICE` | GPU device path (Linux only) | `/dev/dri/renderD128` |
| `ANNEX_NFS_BASE_PATH` | Path to shared media storage | `/mnt/downloads` |
| `ANNEX_LOG_LEVEL` | Logging verbosity | `info` |
| `ANNEX_MAX_CONCURRENT` | Max concurrent encoding jobs | `1` |

### Available Binaries

- `annex-encoder-linux-x64`
- `annex-encoder-linux-arm64`
- `annex-encoder-windows-x64.exe`
- `annex-encoder-darwin-x64`
- `annex-encoder-darwin-arm64`

### CLI Commands

```bash
annex-encoder                    # Run encoder
annex-encoder --help             # Show help
annex-encoder --version          # Show version
annex-encoder --update           # Self-update from server
annex-encoder --setup            # Generate service files
annex-encoder --setup --install  # Generate and install service
```

## Backup and Restore

### Backup

```bash
# Stop the container
docker stop annex

# Backup volumes
docker run --rm \
  -v annex-postgres:/data/postgres \
  -v annex-config:/data/config \
  -v $(pwd):/backup \
  alpine tar czf /backup/annex-backup.tar.gz /data

# Restart
docker start annex
```

### Restore

```bash
# Stop and remove existing container
docker stop annex && docker rm annex

# Restore volumes
docker run --rm \
  -v annex-postgres:/data/postgres \
  -v annex-config:/data/config \
  -v $(pwd):/backup \
  alpine tar xzf /backup/annex-backup.tar.gz -C /

# Start fresh container
docker run -d --name annex ... # (your usual run command)
```

## Troubleshooting

### View logs

```bash
docker logs -f annex
```

### Access container shell

```bash
docker exec -it annex bash
```

### Check service status

```bash
docker exec annex ps aux
```

### Database connection issues

If using external PostgreSQL, verify connectivity:

```bash
docker exec annex psql "$DATABASE_URL" -c "SELECT 1"
```

### Encoder not connecting

Check encoder logs and verify WebSocket connectivity:

```bash
# Inside container
docker exec annex cat /app/encoder/logs/*
```

Ensure the encoder can reach the server on port 80 (or 3001 internally).
