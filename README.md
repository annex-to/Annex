# Annex

Unified media acquisition platform replacing Jellyseerr, Radarr, Sonarr & Prowlarr. Handles discovery, requests, downloading, AV1 encoding via remote hardware encoders, and delivery to storage servers. Tight Plex/Emby integration for library awareness. Built with React, Bun, tRPC & PostgreSQL.

## What Annex Replaces

| Tool | Functionality | Now Handled By |
|------|---------------|----------------|
| Jellyseerr/Overseerr | Request UI, trending media | Annex UI |
| Radarr | Movie management | Annex Core |
| Sonarr | TV show management | Annex Core |
| Prowlarr | Indexer management | Annex Indexer Module |
| qBittorrent | Torrent downloading | Still used (via API) |

## Documentation

- [Docker Deployment](docs/deployment.md) - Deploy with Docker (recommended)
- [Development Setup](docs/development.md) - Local development environment
- [Contributing](docs/CONTRIBUTING.md) - Contribution guidelines
- [Code of Conduct](docs/CODE_OF_CONDUCT.md) - Community guidelines

## Features

- **Discovery** - Browse trending movies and TV shows via TMDB with aggregated ratings from MDBList (IMDB, RT, Metacritic, Trakt, Letterboxd)
- **Request Management** - One-click requests with real-time progress tracking
- **Multi-Indexer Search** - Search across multiple Torznab indexers with quality prioritization
- **Remote AV1 Encoding** - Distributed encoding via remote encoder nodes with Intel Arc VAAPI hardware acceleration
- **Per-Server Quality Profiles** - Different encoding profiles per storage server (4K HDR, 1080p, 720p compact)
- **Smart Naming** - Plex/Emby-compatible file naming before transfer
- **Multi-Server Delivery** - Deliver to multiple storage servers via SFTP/rsync/SMB
- **Plex/Emby Integration** - Library awareness, duplicate prevention, automatic scan triggers

## Architecture

```
Request → Search Indexers → Download (qBittorrent) → Encode (Remote AV1) → Name → Deliver → Notify Plex/Emby
```

### Core Philosophy: Encode First, Transfer Minimal

1. **Download** the highest quality source (remux, BluRay)
2. **Encode to AV1** on remote encoder nodes with hardware acceleration
3. **Name the file** according to Plex/Emby conventions
4. **Transfer only the final, encoded file** to storage servers

### Remote Encoder System

Encoding is offloaded to dedicated encoder VMs with Intel Arc GPUs via VAAPI:

```
Annex Server ←──WebSocket──→ Encoder 1 (Intel Arc)
                         ├──→ Encoder 2 (Intel Arc)
                         └──→ Encoder N (Intel Arc)
                                    │
                              NFS Mount (shared storage)
```

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS
- **Backend**: Bun, TypeScript, tRPC, PostgreSQL, Prisma
- **Encoding**: FFmpeg with VAAPI (Intel Arc AV1)
- **Communication**: tRPC (HTTP + WebSocket subscriptions)

## Quick Start

### Docker (Recommended)

```bash
docker run -d \
  --name annex \
  -p 80:80 \
  -v annex-postgres:/data/postgres \
  -v annex-config:/data/config \
  -v /path/to/downloads:/downloads \
  ghcr.io/wehavenoeyes/annex:latest
```

Access the web UI at `http://localhost` and complete the setup wizard.

See [Docker Deployment](docs/deployment.md) for more options including external PostgreSQL and GPU encoding.

### Manual Installation

Prerequisites: Bun 1.0+, PostgreSQL, qBittorrent

```bash
git clone https://github.com/WeHaveNoEyes/Annex.git
cd Annex
bun install
cp .env.example .env  # Edit with your configuration
bunx prisma migrate deploy
bun run build && bun run start
```

Access the web UI at `http://localhost:3000`

### Development

```bash
# Start development servers
bun run dev
```

This starts:
- Backend server at `http://localhost:3000`
- Frontend dev server at `http://localhost:5173`

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `TMDB_API_KEY` | API key from themoviedb.org |
| `ANNEX_MDBLIST_API_KEY` | MDBList API key for aggregated ratings |
| `QBITTORRENT_URL` | qBittorrent WebUI URL |
| `QBITTORRENT_USERNAME` | qBittorrent username |
| `QBITTORRENT_PASSWORD` | qBittorrent password |
| `ENCODER_SERVER_DOWNLOADS_PATH` | Server-side downloads path |
| `ENCODER_REMOTE_DOWNLOADS_PATH` | Encoder-side downloads path (NFS mount) |

### Deploying Remote Encoders

Remote encoders are distributed as standalone executables (no Bun runtime required). Download platform-specific binaries from GitHub Releases.

**Linux:**
```bash
# Download binary
curl -L https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-linux-x64 -o annex-encoder
chmod +x annex-encoder

# Setup and install service
sudo ./annex-encoder --setup --install

# Configure
sudo nano /etc/annex-encoder.env

# Start
sudo systemctl start annex-encoder
```

**Windows (run as Administrator):**
```powershell
# Download binary
Invoke-WebRequest -Uri "https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-windows-x64.exe" -OutFile "annex-encoder.exe"

# Setup and install service
.\annex-encoder.exe --setup --install

# Start
Start-Service AnnexEncoder
```

**macOS:**
```bash
# Download binary (use darwin-arm64 for Apple Silicon)
curl -L https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-darwin-arm64 -o annex-encoder
chmod +x annex-encoder

# Setup and install service
./annex-encoder --setup --install

# Start
launchctl start com.annex.encoder
```

See [docs/deployment.md](docs/deployment.md) for more details.

## Project Structure

```
annex/
├── packages/
│   ├── client/          # React frontend (Vite)
│   ├── server/          # Bun backend (tRPC)
│   ├── encoder/         # Remote encoder package
│   └── shared/          # Shared TypeScript types
├── scripts/             # Deployment scripts
└── prisma/              # Database schema
```

## Encoding Profiles

| Profile | Resolution | CRF | HDR | Use Case |
|---------|------------|-----|-----|----------|
| 4K HDR Master | 4K | 22 | Preserve | Home theater |
| 2K Quality | 1440p | 23 | Tonemap | High-quality streaming |
| 1080p Standard | 1080p | 24 | Tonemap | General use |
| 720p Compact | 720p | 28 | Strip | Mobile/low bandwidth |

## Systemd Service

```ini
[Unit]
Description=Annex Media Acquisition Platform
After=network.target postgresql.service

[Service]
Type=simple
User=annex
WorkingDirectory=/opt/annex
ExecStart=/usr/local/bin/bun packages/server/src/index.ts
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## License

MIT
