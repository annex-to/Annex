# Development Setup

## Prerequisites

- Node.js 20+
- pnpm 9+
- PostgreSQL 14+
- qBittorrent (optional, for download testing)

## Clone and Install

```bash
git clone git@github.com:WeHaveNoEyes/Annex.git
cd Annex
pnpm install
```

## Database Setup

Create a PostgreSQL database:

```bash
sudo -u postgres createuser annex
sudo -u postgres psql -c "ALTER USER annex WITH PASSWORD 'annex';"
sudo -u postgres createdb annex -O annex
```

## Environment Configuration

Copy the example environment file:

```bash
cp packages/server/.env.example packages/server/.env
```

Required variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `TMDB_API_KEY` | Get from [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) |

Optional variables for full functionality:

| Variable | Description |
|----------|-------------|
| `QBITTORRENT_URL` | qBittorrent WebUI URL (default: `http://localhost:8080`) |
| `QBITTORRENT_USERNAME` | qBittorrent username |
| `QBITTORRENT_PASSWORD` | qBittorrent password |
| `OMDB_API_KEY` | For IMDB/RT/Metacritic ratings |
| `TRAKT_CLIENT_ID` | For Trakt ratings |

## Run Migrations

```bash
pnpm --filter @annex/server prisma migrate dev
```

## Start Development Servers

```bash
pnpm dev
```

This starts:
- Backend: http://localhost:3000
- Frontend: http://localhost:5173

The frontend proxies API requests to the backend automatically.

## Project Structure

```
packages/
├── client/     # React frontend (Vite)
├── server/     # Node.js backend (tRPC + Express)
├── encoder/    # Remote encoder package
└── shared/     # Shared TypeScript types
```

## Common Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all dev servers |
| `pnpm build` | Build all packages |
| `pnpm start` | Start production server |
| `pnpm typecheck` | Run TypeScript checks |
| `pnpm lint` | Run linting |
| `pnpm clean` | Remove all build artifacts and node_modules |

## Database Commands

```bash
# Run migrations
pnpm --filter @annex/server prisma migrate dev

# Open Prisma Studio (database GUI)
pnpm --filter @annex/server prisma studio

# Reset database
pnpm --filter @annex/server prisma migrate reset

# Generate Prisma client after schema changes
pnpm --filter @annex/server prisma generate
```

## Troubleshooting

### Port already in use

Kill the process using the port:

```bash
# Find process on port 3000
lsof -i :3000
# Kill it
kill -9 <PID>
```

### Database connection issues

Verify PostgreSQL is running:

```bash
sudo systemctl status postgresql
```

Check connection:

```bash
psql -U annex -d annex -h localhost
```

### Prisma client out of sync

Regenerate after schema changes:

```bash
pnpm --filter @annex/server prisma generate
```
