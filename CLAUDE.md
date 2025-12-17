# Annex

Media acquisition platform: discovery → request → download → encode (AV1) → deliver to storage servers.

## Guidelines

- No emojis in code, commits, or communication
- Keep commit messages short: `type(scope): description`
- Code should be self-documenting; avoid unnecessary comments
- Don't over-explain in responses; be direct
- Prefer simple solutions over clever ones

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS, tRPC client
- **Backend**: Bun, TypeScript, tRPC, PostgreSQL, Prisma ORM
- **Encoding**: Remote encoders with FFmpeg VAAPI (Intel Arc AV1)
- **External APIs**: TMDB (metadata), MDBList (ratings), qBittorrent (downloads), Plex/Emby (library)

## Project Structure

```
packages/
├── client/              # React frontend
│   └── src/
│       ├── components/  # UI components
│       │   └── ui/      # Reusable design system components
│       ├── pages/       # Route pages
│       ├── hooks/       # React hooks
│       └── trpc.ts      # tRPC client setup
├── server/              # Bun backend
│   └── src/
│       ├── routers/     # tRPC routers (discovery, requests, servers, indexers, encoders, library, sync, system)
│       ├── services/    # Business logic (metadata, indexer, download, encoderDispatch, delivery, naming, plex, emby, mdblist, sync, jobQueue)
│       └── index.ts     # Entry point, Bun.serve() with native WebSocket
├── encoder/             # Remote encoder package (standalone, bundled with Bun)
│   └── src/
│       ├── client.ts    # WebSocket client
│       ├── encoder.ts   # FFmpeg VAAPI wrapper
│       └── config.ts    # Environment config
└── shared/              # Shared types
    └── src/types/
        └── encoder.ts   # Encoder WebSocket message types
```

## Commands

```bash
bun install           # Install dependencies
bun run dev           # Start dev servers (backend :3000, frontend :5173)
bun run build         # Build all packages
bun run lint          # Lint code with ESLint
bun run test          # Run tests across all packages
bun run typecheck     # Type check all packages
bunx prisma migrate   # Run database migrations
bunx prisma studio    # Open Prisma database GUI

# Encoder package
bun packages/encoder/scripts/build-dist.js  # Build distributable tarball
```

## Key Data Models (Prisma)

```prisma
model MediaItem {
  id, tmdbId, type (movie/tv), title, year, overview, posterPath, backdropPath
  popularity, voteAverage, voteCount, genres, status, runtime
  # MDBList ratings
  imdbId, imdbRating, rottenTomatoesRating, metacriticRating, traktRating, letterboxdRating
  mdblistUpdatedAt
}

model StorageServer {
  id, name, host, port, protocol (sftp/rsync/smb), credentials (encrypted)
  moviePath, tvPath, maxResolution, maxFileSize, maxBitrate
  mediaServerType (plex/emby/none), mediaServerUrl, mediaServerApiKey
}

model Indexer {
  id, name, type (torznab/newznab/rss), url, apiKey
  movieCategories, tvCategories, priority, enabled
}

model MediaRequest {
  id, type, tmdbId, title, year
  status (pending/searching/downloading/encoding/delivering/completed/failed)
  progress, error, targetServers
}

model EncodingJob {
  id, requestId, inputPath, outputPath, profileId
  status (pending/assigned/encoding/completed/failed)
  encoderId, progress, fps, speed, eta
}

model BackgroundJob {
  id, type, payload, status (pending/processing/completed/failed)
  attempts, maxAttempts, error, lockedAt, lockedBy
}
```

## tRPC Router Structure

```typescript
appRouter = {
  discovery: { trending, search, details, genres },
  requests: { create, list, get, cancel, retry, onProgress (subscription) },
  servers: { list, get, create, update, delete, test },
  indexers: { list, get, create, update, delete, test, search },
  encoders: { list, status, jobs, submitJob, cancelJob, remove },
  library: { movies, tvShows, sync },
  sync: { status, startFullSync, startIncrementalSync, refreshStale, queueStats },
  system: { health, stats, activity }
}
```

## Remote Encoder System

Encoders are distributed as single-file executables (no Bun runtime required). Built with `bun build --compile` for cross-platform support.

### Distribution

Binaries available for:
- `linux-x64`, `linux-arm64`
- `windows-x64`
- `darwin-x64`, `darwin-arm64`

Download from GitHub Releases or server endpoints:
- `GET /api/encoder/package/info` - Manifest with versions and checksums
- `GET /api/encoder/binary/{platform}` - Platform-specific binary

### CLI Commands

```bash
annex-encoder                    # Run encoder
annex-encoder --help             # Show help
annex-encoder --version          # Show version
annex-encoder --update           # Self-update from server
annex-encoder --setup            # Generate service files
annex-encoder --setup --install  # Generate and install service
```

### Installation

**Quick Start (Linux):**
```bash
# Download binary
curl -L https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-linux-x64 -o annex-encoder
chmod +x annex-encoder

# Setup and install service
sudo ./annex-encoder --setup --install

# Edit configuration
sudo nano /etc/annex-encoder.env

# Start service
sudo systemctl start annex-encoder
```

**Quick Start (Windows):**
```powershell
# Download binary
Invoke-WebRequest -Uri "https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-windows-x64.exe" -OutFile "annex-encoder.exe"

# Setup service (run as Administrator)
.\annex-encoder.exe --setup --install

# Start service
Start-Service AnnexEncoder
```

**Quick Start (macOS):**
```bash
# Download binary
curl -L https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-darwin-arm64 -o annex-encoder
chmod +x annex-encoder

# Setup service
./annex-encoder --setup --install

# Start service
launchctl start com.annex.encoder
```

### WebSocket Protocol

Encoders connect via WebSocket to `ws://server:3000/encoder`. Message types in `packages/shared/src/types/encoder.ts`:
- `register` → `registered` (encoder registration)
- `job:assign` → `job:accepted` / `job:rejected` (job assignment)
- `job:progress` (real-time encoding progress)
- `job:complete` / `job:failed` (job completion)
- `heartbeat` → `heartbeat:ack` (keepalive)

Path translation: Server paths mapped to encoder NFS mount paths via env vars:
```
ENCODER_SERVER_DOWNLOADS_PATH=/media/downloads
ENCODER_REMOTE_DOWNLOADS_PATH=/mnt/downloads
```

### Building

```bash
bun run --filter @annex/encoder build    # Build cross-platform binaries
```

Outputs to `packages/encoder/dist-binaries/`:
- Platform-specific binaries
- `manifest.json` with SHA256 checksums

### Releasing

Use GitHub Actions workflow with manual trigger:
1. Go to Actions → Encoder Release
2. Run workflow and select version bump (patch/minor/major)
3. Workflow builds binaries, creates tag `encoder-v{version}`, and publishes release

## Background Job Queue

Database-backed queue in `services/jobQueue.ts`. No Redis required.

Job types:
- `mdblist:hydrate`, `mdblist:batch-hydrate` - Fetch ratings
- `sync:full`, `sync:incremental`, `sync:refresh-stale` - Media sync

Config: `ANNEX_JOB_CONCURRENCY`, `ANNEX_JOB_POLL_INTERVAL`

## UI Design System

Dark cinema theme with glassy elements. Colors defined in `tailwind.config.js`:

```
annex-500: #ef4444 (primary red)
annex-600: #dc2626
gold-500: #eab308 (accent)
Background: black with red ambient glow
```

### Component Patterns

```
Buttons:    bg-annex-500/20 text-annex-400 border-annex-500/30
Secondary:  bg-white/5 text-white/70 border-white/10
Ghost:      bg-transparent text-white/60
Inputs:     bg-white/5 border-white/10 placeholder-white/25
Cards:      bg-white/5 border-white/10 backdrop-blur-sm rounded
```

Use `rounded` (4px), not `rounded-lg`. Transitions: `transition-all duration-150`.

### Reusable Components (`packages/client/src/components/ui/`)

`Button`, `Input`, `Card`, `Badge`, `Label`, `NavButton`, `SidebarNav`, `ToggleGroup`, `EmptyState`

```tsx
import { Button, Input, Card } from "../components/ui";
```

Button has popcorn particle effect on click (50% chance). Disable with `popcorn={false}`.

## File Naming Convention

Plex/Emby compatible naming applied before delivery:

```
Movies:  {title} ({year})/{title} ({year}) [{quality}].mkv
TV:      {series}/Season {season:00}/{series} - S{season:00}E{episode:00} - {episodeTitle} [{quality}].mkv
```

Character sanitization: Replace `:` with ` -`, remove `/\?*"<>|`, trim spaces/dots.

## Environment Variables

```bash
DATABASE_URL=postgresql://...
TMDB_API_KEY=...
ANNEX_MDBLIST_API_KEY=...
QBITTORRENT_URL=http://localhost:8080
QBITTORRENT_USERNAME=admin
QBITTORRENT_PASSWORD=...
PORT=3000

# Encoder path translation
ENCODER_SERVER_DOWNLOADS_PATH=/media/downloads
ENCODER_REMOTE_DOWNLOADS_PATH=/mnt/downloads
```

## Commit Convention

Conventional Commits: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`

```
feat(encoding): add HDR10+ tonemapping support
fix(delivery): handle SFTP timeout gracefully
```
