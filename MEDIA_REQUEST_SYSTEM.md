# Media Request System Documentation

Complete documentation of the Annex media request pipeline, from request creation through completion.

## Table of Contents

1. [System Overview](#system-overview)
2. [Request Creation](#request-creation)
3. [Pipeline Architecture](#pipeline-architecture)
4. [Pipeline Phases](#pipeline-phases)
5. [Worker System](#worker-system)
6. [Monitoring Loops](#monitoring-loops)
7. [Supporting Services](#supporting-services)
8. [Error Handling & Retry](#error-handling--retry)
9. [Database Models](#database-models)
10. [Configuration](#configuration)

---

## System Overview

The Annex media request system is a **distributed, worker-based pipeline** that processes media through distinct phases:

```
Request → Search → Download → Encode → Deliver → Complete
```

Each phase is handled by dedicated workers that:
- Poll for items in specific statuses
- Process with configurable concurrency
- Update progress in real-time
- Transition through a validated state machine
- Handle errors with retry logic

### Key Design Principles

- **Granular Processing**: Movies = 1 item, TV shows = 1 item per episode
- **Database as Truth**: No in-memory state, crash-resilient
- **Atomic Transitions**: State changes validated before commit
- **Progress Tracking**: Real-time updates via WebSocket subscriptions
- **Retry Strategy**: Exponential backoff for transient failures

---

## Request Creation

**Location**: `packages/server/src/routers/requests.ts`

### Movie Requests

**Endpoint**: `requests.createMovie`

**Flow**:
1. User submits:
   - `tmdbId`: The Movie Database ID
   - `title`, `year`: For display and searching
   - `targets`: Array of `{serverId, resolution}` for delivery
   - `selectedRelease` (optional): Pre-selected torrent release
2. Creates `MediaRequest` record with status `PENDING`
3. Calls `pipelineOrchestrator.createRequest()`:
   - Creates single `ProcessingItem` with type `MOVIE`
   - Initializes pipeline execution state
   - Sets up quality profile from target resolutions
4. Returns `{ requestId }` to client
5. Workers begin processing automatically

### TV Show Requests

**Endpoint**: `requests.createTv`

**Flow**:
1. User submits:
   - `tmdbId`, `title`, `year`
   - `targets`: Array of `{serverId, resolution}`
   - `requestedSeasons`: Array of season numbers
   - `requestedEpisodes` (optional): Specific episodes as `{season, episode}[]`
   - `selectedRelease` (optional): Pre-selected torrent
2. Fetches episode metadata from Trakt API:
   - Episode titles, air dates, season/episode numbers
   - Filters to requested seasons/episodes
3. Creates `MediaRequest` record
4. Creates individual `ProcessingItem` for EACH episode:
   - `type: TV`
   - `season`, `episode` fields populated
   - Each episode tracked independently through pipeline
5. Workers process episodes in parallel

**Example**: Requesting Breaking Bad S1 creates 7 `ProcessingItem` records (one per episode).

---

## Pipeline Architecture

**Location**: `packages/server/src/services/pipeline/PipelineOrchestrator.ts`

### Status State Machine

```
PENDING → SEARCHING → FOUND → DOWNLOADING → DOWNLOADED → ENCODING → ENCODED → DELIVERING → COMPLETED
   ↓          ↓         ↓           ↓             ↓           ↓          ↓           ↓
 FAILED    FAILED    FAILED      FAILED        FAILED      FAILED     FAILED      FAILED
```

### PipelineOrchestrator Responsibilities

The orchestrator is the **central coordinator** for all `ProcessingItem` lifecycle management:

#### 1. Request Creation
```typescript
async createRequest(requestId, type, targets, selectedRelease?)
```
- Creates `PipelineExecution` with template
- Creates `ProcessingItem` records (1 for movie, N for TV episodes)
- Initializes state: `PENDING`, progress: 0, attempts: 0

#### 2. State Transitions
```typescript
async transitionStatus(itemId, fromStatus, toStatus, context?)
```
- Validates transition using `ValidationFramework`
- Atomically updates status + stepContext
- Updates request-level aggregates (completedItems, failedItems)
- Emits progress events to subscribed clients

#### 3. Progress Updates
```typescript
async updateProgress(itemId, progress, context?)
```
- Updates `ProcessingItem.progress` (0-100)
- Debounces database writes (5 second minimum)
- Always emits real-time events to UI

#### 4. Error Handling
```typescript
async handleError(itemId, error, phase)
```
- Evaluates retry eligibility via `RetryStrategy`
- Increments `attempts`, sets `nextRetryAt` if retriable
- Transitions to `FAILED` if max attempts exceeded
- Updates `error` field with message

#### 5. Context Management
```typescript
async updateContext(itemId, context)
```
- Stores phase-specific data in `stepContext` JSON field
- Example contexts: `search`, `download`, `encode`, `deliver`
- Used for resume/retry scenarios

### Validation Framework

**Location**: `packages/server/src/services/pipeline/ValidationFramework.ts`

Enforces valid state transitions:
- Only allows transitions in the state machine
- Prevents invalid jumps (e.g., PENDING → ENCODED)
- Throws error on validation failure

---

## Pipeline Phases

### Phase 1: Search

**Status Flow**: `PENDING → SEARCHING → FOUND`
**Worker**: `SearchWorker`
**Step**: `SearchStep`

#### Process Flow

1. **SearchWorker** polls items with status `PENDING`
2. Transitions item to `SEARCHING`
3. **SearchStep.execute()**:
   - Queries all enabled indexers (Torznab, Newznab, RSS, TorrentLeech, UNIT3D, Cardigann)
   - Searches by `tmdbId`, `imdbId`, or text query
   - For TV: Searches for season packs OR individual episodes
   - Scores releases using quality profile:
     ```typescript
     score = resolutionRank + sourceRank + codecRank + seederBonus + properBonus
     ```
   - Checks qBittorrent for existing downloads (deduplication)
   - Selects best release OR reuses existing download
4. Stores results in `stepContext.search`:
   ```typescript
   {
     selectedRelease: {
       indexerId, title, size, magnetUri, resolution, codec, source, score
     },
     selectedPacks: [ // For TV season packs
       { packRelease, episodes: [{season, episode}] }
     ],
     alternativeReleases: [...], // Backup releases
     existingDownload: {
       torrentHash, progress, status
     },
     qualityMet: boolean
   }
   ```
5. Transitions to `FOUND`

#### Season Pack Handling

For TV shows, SearchWorker intelligently selects season packs:
- Checks if a season pack covers multiple requested episodes
- Groups episodes by season
- Atomically links ALL episodes in pack to prevent race conditions
- Falls back to individual episodes if no suitable pack found

**Example**:
```
Request: Breaking Bad S1E1-E7
Search finds: "Breaking.Bad.S01.1080p.BluRay.x264"
Result: All 7 episodes linked to single season pack download
```

### Phase 2: Download

**Status Flow**: `FOUND → DOWNLOADING → DOWNLOADED`
**Workers**: `DownloadWorker`, `DownloadProgressWorker`, `DownloadRecoveryWorker`
**Step**: `DownloadStep`

#### DownloadWorker

1. Polls items with status `FOUND`
2. Reads `stepContext.search` for release or existing download
3. **If existing download**:
   - Reuses torrent from qBittorrent (no new download)
   - Creates `Download` record if missing
   - Links episode via `downloadId` foreign key
   - If torrent at 100%: immediately transitions to `DOWNLOADED`
   - If downloading: waits for completion with 24h timeout
4. **If new release**:
   - Calls `downloadManager.createDownload(release)`
   - Adds torrent to qBittorrent:
     - Magnet URI: Direct add
     - Download URL: Fetches .torrent file, then adds
   - Creates `Download` record with metadata:
     ```typescript
     {
       requestId, qbittorrentHash, magnetUri, size,
       indexerName, resolution, source, codec, seeders, leechers
     }
     ```
   - Polls qBittorrent every 5s until complete
   - **Season Pack**: Atomically links ALL episodes in season to prevent partial updates
5. On completion:
   - Extracts file path from qBittorrent
   - For season packs: Maps files to episodes using `parseTorrentName()`
   - Stores in `stepContext.download`:
     ```typescript
     {
       torrentHash: string,
       sourceFilePath: string, // For movies
       episodeFiles: [        // For TV season packs
         { path: string, season: number, episode: number }
       ]
     }
     ```
6. Transitions to `DOWNLOADED`

#### DownloadProgressWorker

**Purpose**: Syncs download progress to UI in real-time

1. Runs every 5 seconds
2. Fetches items with status `DOWNLOADING`
3. Gets progress from qBittorrent via torrent hash
4. Updates `ProcessingItem.progress` with 1% debouncing
5. Emits progress events to WebSocket subscribers
6. **Does NOT transition** to DOWNLOADED (handled by DownloadWorker)

#### DownloadRecoveryWorker

**Purpose**: Detects downloads stuck at 100%

1. Runs every 60 seconds
2. Finds items in `DOWNLOADING` with 100% progress
3. Transitions them to `DOWNLOADED`
4. Prevents items from getting stuck when DownloadWorker misses completion

### Phase 3: Encoding

**Status Flow**: `DOWNLOADED → ENCODING → ENCODED`
**Workers**: `EncodeWorker`, `EncoderMonitorWorker`
**Step**: `EncodeStep`

#### EncodeWorker

1. Polls items with status `DOWNLOADED`
2. Transitions to `ENCODING`
3. **EncodeStep.execute()**:
   - Extracts input file from `stepContext.download.sourceFilePath`
   - Gets encoding config from pipeline template:
     ```typescript
     {
       targetResolution: "1080p",
       codec: "av1",
       crf: 28,
       preset: "medium",
       hardware: "vaapi"
     }
     ```
   - Generates output filename with naming convention
   - Creates `Job` record (type: `remote:encode`)
   - Calls `encoderDispatch.queueEncodingJob()`:
     - Creates `EncoderAssignment` with status `PENDING`
     - EncoderDispatch tick assigns to available encoder
     - Encoder accepts job via WebSocket
     - Encoding begins, progress synced via `job:progress` messages
4. Sets `encodingJobId` on ProcessingItem
5. Returns immediately (non-blocking)

#### EncoderMonitorWorker

**Purpose**: Transitions items when encoding completes

1. Runs every 5 seconds
2. Fetches items with status `ENCODING`
3. Checks `EncoderAssignment.status`:
   - `COMPLETED`:
     - Extracts `outputPath` from assignment
     - Builds `stepContext.encode`:
       ```typescript
       {
         encodedFiles: [{
           path: "/encoded/Breaking.Bad.S01E01.1080p.AV1.mkv",
           resolution: "1080p",
           codec: "av1",
           targetServerIds: ["server-1", "server-2"]
         }]
       }
       ```
     - Transitions to `ENCODED`
   - `FAILED`:
     - Transitions to `FAILED` with error message
     - Retry logic may attempt with different encoder

### Phase 4: Delivery

**Status Flow**: `ENCODED → DELIVERING → COMPLETED`
**Worker**: `DeliverWorker`
**Step**: `DeliverStep`

#### DeliverWorker

1. Polls items with status `ENCODED` or `DELIVERING` (resume support)
2. Transitions to `DELIVERING` if not already
3. **DeliverStep.execute()**:
   - Gets encoded files from `stepContext.encode.encodedFiles`
   - For each target server:
     - Retrieves `StorageServer` config (protocol, credentials, paths)
     - Generates Plex/Emby-compatible filename:
       ```
       Movies:  /movies/Breaking Bad (2008)/Breaking Bad (2008) [1080p].mkv
       TV:      /tv/Breaking Bad/Season 01/Breaking Bad - S01E01 - Pilot [1080p].mkv
       ```
     - Transfers file via protocol (SFTP, rsync, LOCAL, SMB)
     - Sets file permissions: `nobody:users`, `644`
     - Triggers library scan via Plex/Emby API
     - Tracks progress with callbacks (0-100%)
   - Calculates dynamic timeout based on file size (2 MB/s minimum)
   - Supports cancellation via `AbortSignal`
4. Stores results in `stepContext.deliver`:
   ```typescript
   {
     deliveredServers: [
       { serverId: "srv-1", path: "/movies/...", success: true },
       { serverId: "srv-2", path: "/tv/...", success: true }
     ]
   }
   ```
5. Transitions to `COMPLETED`

#### Delivery Protocol Details

**LOCAL**:
- Direct filesystem copy using `fs.copyFile`
- Fastest method when server has direct access

**SFTP**:
- SSH File Transfer Protocol via `ssh2-sftp-client`
- Progress tracked via stream events
- Automatic directory creation

**RSYNC**:
- rsync over SSH with progress parsing
- Command: `rsync -avz --progress --chmod=644 <src> <dest>`
- Parses output for percentage completion

**SMB**:
- Samba/Windows shares via `smbclient`
- Mounts share temporarily, copies file, unmounts

---

## Worker System

**Location**: `packages/server/src/services/pipeline/workers/`

All workers extend `BaseWorker` and are registered with the scheduler service.

### Worker Base Architecture

```typescript
abstract class BaseWorker {
  abstract processingStatus: ProcessingStatus; // Status this worker polls for
  abstract execute(item: ProcessingItem): Promise<void>; // Processing logic

  concurrency: number = 1;     // Max parallel items
  interval: number = 5000;     // Poll interval (ms)
  enabled: boolean = true;     // Can be disabled
}
```

### Worker Inventory

| Worker | Status | Interval | Concurrency | Purpose |
|--------|--------|----------|-------------|---------|
| **SearchWorker** | PENDING | 5s | 3 | Search indexers for releases |
| **DownloadWorker** | FOUND | 5s | 5 | Initiate downloads via qBittorrent |
| **DownloadProgressWorker** | DOWNLOADING | 5s | ∞ | Sync download progress |
| **DownloadRecoveryWorker** | DOWNLOADING | 60s | ∞ | Detect stuck completed downloads |
| **EncodeWorker** | DOWNLOADED | 5s | 3 | Queue encoding jobs |
| **EncoderMonitorWorker** | ENCODING | 5s | ∞ | Monitor encoding completion |
| **DeliverWorker** | ENCODED | 5s | 2 | Deliver files to storage servers |
| **StuckItemRecoveryWorker** | ALL | 300s | ∞ | Detect and recover stuck items |

### Worker Lifecycle

1. **Scheduler** registers all workers on startup
2. Each worker runs on its interval timer
3. **Poll Phase**:
   - Query database for items in worker's status
   - Filter by `nextRetryAt` (skip items in backoff)
   - Limit by concurrency setting
4. **Execute Phase**:
   - Process each item with worker's `execute()` method
   - Update progress and context
   - Transition to next status on success
   - Handle errors with retry logic
5. **Cleanup**:
   - Log results (success/failure counts)
   - Schedule next iteration

---

## Monitoring Loops

### 1. Download Progress Monitoring

**Worker**: `DownloadProgressWorker`
**Interval**: 5 seconds
**Purpose**: Real-time download progress updates

**Process**:
1. Fetches all items with status `DOWNLOADING`
2. Groups by `downloadId` to batch qBittorrent queries
3. Calls `qbittorrent.getTorrentInfo(hash)` for each download
4. Updates progress with 1% debouncing (prevents spam)
5. Emits WebSocket events for UI updates
6. Logs warnings for stalled torrents (no progress in 10 minutes)

**Debouncing Logic**:
```typescript
if (Math.abs(newProgress - oldProgress) >= 1) {
  await db.update({ progress: newProgress });
  emitEvent('progress', { progress: newProgress });
}
```

### 2. Encoding Progress Monitoring

**Worker**: `EncoderMonitorWorker`
**Interval**: 5 seconds
**Purpose**: Detect encoding completion and sync progress

**Process**:
1. Fetches all items with status `ENCODING`
2. Joins with `EncoderAssignment` to get job status
3. For each item:
   - If assignment `COMPLETED`: Transition to `ENCODED`
   - If assignment `FAILED`: Transition to `FAILED`
   - If assignment `ENCODING`: Update progress from assignment
4. Emits progress events to UI

**EncoderDispatch Sync Loop**:
- Separate service running every 5 seconds
- Updates `EncoderAssignment.progress` from WebSocket messages
- Manages encoder health and job assignment
- See [Encoder Dispatch Service](#encoder-dispatch-service) for details

### 3. Stuck Item Recovery

**Worker**: `StuckItemRecoveryWorker`
**Interval**: 5 minutes (300s)
**Purpose**: Detect and recover items stuck in processing statuses

**Detection Criteria**:

| Status | Stuck If... | Recovery Action |
|--------|-------------|-----------------|
| SEARCHING | >30 minutes without progress | Retry search with backoff |
| DOWNLOADING | >2 hours at same progress | Check qBittorrent, retry or fail |
| ENCODING | EncoderAssignment FAILED/CANCELLED | Transition to FAILED, retry eligible |
| DELIVERING | >2 hours without completion | Retry delivery or fail |

**Process**:
1. Query for items in processing statuses
2. Check `updatedAt` timestamp vs threshold
3. For stuck items:
   - Log warning with item details
   - Call `pipelineOrchestrator.handleError()`
   - Retry logic determines next action
4. Emit alerts for admin review

### 4. Encoder Health Monitoring

**Service**: `EncoderDispatch`
**Interval**: 5 seconds
**Purpose**: Manage remote encoder lifecycle

**Tick Loop Responsibilities**:

1. **Mark Offline Encoders**:
   - Find encoders with `lastHeartbeatAt > 90s ago`
   - Set `status: OFFLINE`
   - Emit alerts

2. **Reset Stuck Assignments**:
   - Find assignments in `ASSIGNED` for >30s
   - Reset to `PENDING` for reassignment
   - Prevents jobs stuck waiting for encoder acceptance

3. **Detect Stalled Jobs**:
   - Find assignments in `ENCODING` with no progress for >2 minutes
   - Retry or fail based on retry strategy

4. **Detect Stuck Completed Jobs**:
   - Find assignments at 100% progress but still `ENCODING`
   - Transition to `COMPLETED`

5. **Assign Pending Jobs**:
   - Match `PENDING` assignments to `ONLINE` encoders
   - Check encoder capacity and load
   - Send `job:assign` WebSocket message
   - Update assignment status to `ASSIGNED`

6. **Sync Progress**:
   - Update all ENCODING items from assignments
   - Debounced database writes (5s minimum)
   - Always emit UI events

### 5. Request Status Computation

**Service**: `RequestStatusComputer`
**Trigger**: On-demand (not a loop)
**Purpose**: Compute request-level status from ProcessingItems

**Computation Rules**:

1. **Status Priority** (highest to lowest):
   - If ANY item `FAILED` and NONE processing → `FAILED`
   - If ALL items `COMPLETED` → `COMPLETED`
   - If ANY item `DELIVERING` → `DELIVERING`
   - If ANY item `ENCODING` → `ENCODING`
   - If ANY item `DOWNLOADING` → `DOWNLOADING`
   - If ANY item `FOUND` → `FOUND`
   - If ANY item `SEARCHING` → `SEARCHING`
   - Default → `PENDING`

2. **Progress Calculation**:
   ```typescript
   progress = (completedItems / totalItems) * 100
   ```

3. **Current Step**:
   - Determined by highest status in priority order
   - Example: If 3 items DOWNLOADING, 2 items ENCODING → step is "Encoding"

4. **Error Aggregation**:
   - If any item failed, show first error message
   - Full error list available in item details

**Used By**:
- `requests.list` endpoint (batch computation for all requests)
- `requests.get` endpoint (single request)
- Real-time subscriptions (`requests.onProgress`)

---

## Supporting Services

### Encoder Dispatch Service

**Location**: `packages/server/src/services/encoderDispatch.ts`

**Architecture**:
- Database is **single source of truth** (no in-memory state)
- Single unified tick loop handles all encoder management
- Crash-resilient: Server restart seamlessly resumes jobs
- Progress debouncing prevents database overload

#### WebSocket Protocol

**Endpoint**: `ws://server:3000/encoder`

**Connection Flow**:
1. Encoder connects with `register` message:
   ```typescript
   {
     type: 'register',
     data: {
       name: 'encoder-01',
       capabilities: {
         codecs: ['av1', 'hevc'],
         hardware: 'vaapi',
         maxConcurrentJobs: 2
       }
     }
   }
   ```
2. Server responds with `registered`:
   ```typescript
   {
     type: 'registered',
     data: {
       encoderId: 'enc-abc123',
       serverTime: 1234567890
     }
   }
   ```
3. Server sends periodic `heartbeat` (every 30s)
4. Encoder responds with `heartbeat:ack`

**Job Assignment Flow**:
1. Server sends `job:assign`:
   ```typescript
   {
     type: 'job:assign',
     data: {
       jobId: 'job-xyz',
       assignmentId: 'asn-123',
       inputPath: '/remote/downloads/movie.mkv',
       outputPath: '/remote/encoded/movie.av1.mkv',
       profile: { resolution: '1080p', crf: 28, preset: 'medium' }
     }
   }
   ```
2. Encoder responds with `job:accepted` or `job:rejected`
3. Encoder sends periodic `job:progress`:
   ```typescript
   {
     type: 'job:progress',
     data: {
       assignmentId: 'asn-123',
       progress: 45.2,
       fps: 28.5,
       speed: '1.2x',
       eta: 1200 // seconds
     }
   }
   ```
4. Encoder sends `job:complete` or `job:failed` when done

#### Path Translation

Server paths are translated to encoder NFS mount paths:

**Environment Variables**:
```bash
ENCODER_SERVER_DOWNLOADS_PATH=/media/downloads
ENCODER_REMOTE_DOWNLOADS_PATH=/mnt/downloads
```

**Example**:
```
Server path:  /media/downloads/movie.mkv
Encoder path: /mnt/downloads/movie.mkv
```

Ensures encoders can access files via shared storage (NFS, SMB).

### Download Manager

**Location**: `packages/server/src/services/downloadManager.ts`

#### Responsibilities

1. **Torrent Addition**:
   - Magnet URIs: Direct add to qBittorrent
   - Download URLs: Fetch .torrent file, then add
   - Categories: Automatic movie/tv categorization
   - Save paths: Separate directories per category

2. **Release Scoring**:
   ```typescript
   function scoreRelease(release, profile) {
     let score = 0;

     // Resolution rank (4K=4, 1080p=3, 720p=2, etc.)
     score += getResolutionRank(release.resolution);

     // Source rank (BluRay=3, WEB-DL=2, HDTV=1)
     score += getSourceRank(release.source);

     // Codec rank (AV1=3, HEVC=2, H264=1)
     score += getCodecRank(release.codec);

     // Seeder bonus (up to 10 points)
     score += Math.min(release.seeders / 10, 10);

     // Proper/Repack bonus
     if (release.isProper) score += 5;

     return score;
   }
   ```

3. **Health Monitoring**:
   - Stalled detection: No progress for >30 minutes
   - Low seeder warnings: <5 seeders
   - Automatic retry with alternative releases

4. **Deduplication**:
   - Checks qBittorrent for existing torrents
   - Reuses downloads across requests
   - Prevents duplicate downloads

5. **Reconciliation** (on startup):
   - Scans qBittorrent for orphaned torrents
   - Creates missing `Download` records
   - Links to existing requests if possible

### Delivery Service

**Location**: `packages/server/src/services/delivery.ts`

#### Protocol Implementations

**SFTP**:
```typescript
async deliverSFTP(config, localPath, remotePath, onProgress) {
  const client = new SFTPClient();
  await client.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password
  });

  // Create directory structure
  await client.mkdir(path.dirname(remotePath), true);

  // Upload with progress
  await client.fastPut(localPath, remotePath, {
    step: (transferred, chunk, total) => {
      onProgress((transferred / total) * 100);
    }
  });

  // Set permissions
  await client.exec(`chown nobody:users ${remotePath}`);
  await client.exec(`chmod 644 ${remotePath}`);

  await client.end();
}
```

**RSYNC**:
```typescript
async deliverRsync(config, localPath, remotePath, onProgress) {
  const cmd = `rsync -avz --progress --chmod=644 ${localPath} ${config.username}@${config.host}:${remotePath}`;

  const process = spawn('rsync', args);

  process.stdout.on('data', (data) => {
    // Parse: "  1,234,567  45%  123.45kB/s  0:01:23"
    const match = data.toString().match(/(\d+)%/);
    if (match) {
      onProgress(parseInt(match[1]));
    }
  });

  await waitForExit(process);
}
```

**LOCAL**:
```typescript
async deliverLocal(localPath, remotePath, onProgress) {
  await fs.mkdir(path.dirname(remotePath), { recursive: true });

  await fs.copyFile(localPath, remotePath);

  await fs.chown(remotePath, 'nobody', 'users');
  await fs.chmod(remotePath, 0o644);

  onProgress(100);
}
```

#### File Naming Convention

**Movies**:
```
{title} ({year})/
  {title} ({year}) [{quality}].mkv

Example:
  Breaking Bad (2008)/
    Breaking Bad (2008) [1080p].mkv
```

**TV Shows**:
```
{series}/
  Season {season:00}/
    {series} - S{season:00}E{episode:00} - {episodeTitle} [{quality}].mkv

Example:
  Breaking Bad/
    Season 01/
      Breaking Bad - S01E01 - Pilot [1080p].mkv
```

**Character Sanitization**:
- Replace `:` with ` -`
- Remove `/ \ ? * " < > |`
- Trim leading/trailing spaces and dots

#### Library Scan Triggers

**Plex**:
```typescript
await fetch(`${plexUrl}/library/sections/${sectionId}/refresh`, {
  method: 'POST',
  headers: { 'X-Plex-Token': plexToken }
});
```

**Emby**:
```typescript
await fetch(`${embyUrl}/Library/Refresh`, {
  method: 'POST',
  headers: { 'X-Emby-Token': embyApiKey }
});
```

---

## Error Handling & Retry

**Location**: `packages/server/src/services/pipeline/RetryStrategy.ts`

### Retry Configuration

```typescript
interface RetryConfig {
  maxAttempts: 3;           // Maximum retry attempts
  baseDelay: 60000;         // 1 minute base delay
  maxDelay: 3600000;        // 1 hour max delay
  exponentialBackoff: true; // 1m → 2m → 4m → 8m
}
```

### Error Classification

**Transient Errors** (retriable):
- Network timeouts
- Connection refused
- HTTP 5xx errors
- Indexer rate limits
- Encoder unavailable
- SFTP connection drops

**Permanent Errors** (fail immediately):
- File not found
- Invalid torrent hash
- Validation failures
- Permission denied
- Disk full
- Invalid configuration

### Retry Flow

1. **Worker catches exception**:
   ```typescript
   try {
     await step.execute(item);
   } catch (error) {
     await pipelineOrchestrator.handleError(item.id, error, 'download');
   }
   ```

2. **RetryStrategy evaluates**:
   ```typescript
   function shouldRetry(error, attempts) {
     // Max attempts exceeded
     if (attempts >= maxAttempts) return false;

     // Permanent error
     if (isPermanentError(error)) return false;

     // Transient error - retry
     return true;
   }
   ```

3. **If retriable**:
   - Increment `attempts`
   - Calculate `nextRetryAt`:
     ```typescript
     delay = baseDelay * (2 ** attempts); // Exponential backoff
     nextRetryAt = now + Math.min(delay, maxDelay);
     ```
   - Keep item in current status
   - Workers skip item until `nextRetryAt` passes

4. **If not retriable**:
   - Transition to `FAILED`
   - Set `error` field with message
   - Update request status
   - Emit failure event

### Manual Retry

Users can retry failed items via UI:

**Endpoint**: `requests.retry`

**Process**:
1. Resets `attempts` to 0
2. Clears `error` and `nextRetryAt`
3. Transitions back to `PENDING`
4. Workers pick up item on next poll

---

## Database Models

### MediaRequest

**Location**: `packages/server/prisma/schema.prisma`

```prisma
model MediaRequest {
  id               String   @id @default(cuid())
  type             MediaType
  tmdbId           Int
  title            String
  year             Int
  posterPath       String?

  // Target configuration
  targets          Json     // [{serverId, resolution}]
  requestedSeasons Int[]
  requestedEpisodes Json?   // [{season, episode}]

  // Computed status (from ProcessingItems)
  status           RequestStatus
  progress         Int      @default(0)
  currentStep      String?
  error            String?

  // Aggregates
  totalItems       Int      @default(0)
  completedItems   Int      @default(0)
  failedItems      Int      @default(0)

  // Metadata
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  completedAt      DateTime?

  // Relations
  processingItems  ProcessingItem[]
  downloads        Download[]
}
```

### ProcessingItem

**Location**: `packages/server/prisma/schema.prisma`

```prisma
model ProcessingItem {
  id               String   @id @default(cuid())
  requestId        String
  request          MediaRequest @relation(fields: [requestId], references: [id])

  // Item type
  type             ProcessingItemType // MOVIE | TV
  season           Int?
  episode          Int?
  episodeTitle     String?

  // Pipeline state
  status           ProcessingStatus
  progress         Int      @default(0)
  currentStep      String?
  stepContext      Json     @default("{}")

  // Retry logic
  attempts         Int      @default(0)
  maxAttempts      Int      @default(3)
  nextRetryAt      DateTime?
  error            String?

  // Foreign keys
  downloadId       String?
  download         Download? @relation(fields: [downloadId], references: [id])
  encodingJobId    String?

  // Timestamps
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  completedAt      DateTime?
}
```

### Download

```prisma
model Download {
  id               String   @id @default(cuid())
  requestId        String
  request          MediaRequest @relation(fields: [requestId], references: [id])

  // qBittorrent
  qbittorrentHash  String   @unique
  magnetUri        String?
  status           DownloadStatus
  progress         Int      @default(0)

  // Metadata
  indexerName      String?
  resolution       String?
  source           String?
  codec            String?
  size             BigInt?
  seeders          Int?
  leechers         Int?
  publishDate      DateTime?
  qualityScore     Int?

  // File paths
  savePath         String?
  files            Json?    // [{path, size, season?, episode?}]

  // Timestamps
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  completedAt      DateTime?

  // Relations
  processingItems  ProcessingItem[]
}
```

### EncoderAssignment

```prisma
model EncoderAssignment {
  id               String   @id @default(cuid())
  jobId            String
  job              Job      @relation(fields: [jobId], references: [id])
  encoderId        String?
  encoder          RemoteEncoder? @relation(fields: [encoderId], references: [id])

  // Status
  status           AssignmentStatus
  progress         Int      @default(0)

  // Encoding metrics
  fps              Float?
  speed            String?
  eta              Int?     // seconds

  // Paths
  inputPath        String
  outputPath       String
  profile          Json

  // Error handling
  attempts         Int      @default(0)
  error            String?

  // Timestamps
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  startedAt        DateTime?
  completedAt      DateTime?
}
```

### RemoteEncoder

```prisma
model RemoteEncoder {
  id               String   @id @default(cuid())
  name             String   @unique
  status           EncoderStatus

  // Capabilities
  capabilities     Json     // {codecs, hardware, maxConcurrentJobs}

  // Health
  currentLoad      Int      @default(0)
  lastHeartbeatAt  DateTime @default(now())

  // Connection
  connectionId     String?  @unique

  // Relations
  assignments      EncoderAssignment[]

  // Timestamps
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
}
```

---

## Configuration

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/annex

# External APIs
TMDB_API_KEY=your_tmdb_api_key
ANNEX_MDBLIST_API_KEY=your_mdblist_key
TRAKT_CLIENT_ID=your_trakt_client_id

# Download Client
QBITTORRENT_URL=http://localhost:8080
QBITTORRENT_USERNAME=admin
QBITTORRENT_PASSWORD=adminpass

# Encoder Path Translation
ENCODER_SERVER_DOWNLOADS_PATH=/media/downloads
ENCODER_REMOTE_DOWNLOADS_PATH=/mnt/downloads
ENCODER_SERVER_ENCODED_PATH=/media/encoded
ENCODER_REMOTE_ENCODED_PATH=/mnt/encoded

# Worker Configuration
ANNEX_SEARCH_WORKER_CONCURRENCY=3
ANNEX_DOWNLOAD_WORKER_CONCURRENCY=5
ANNEX_ENCODE_WORKER_CONCURRENCY=3
ANNEX_DELIVER_WORKER_CONCURRENCY=2

# Server
PORT=3000
NODE_ENV=production
```

### Worker Intervals

**Default**: 5 seconds for all workers

**Configurable via code**:
```typescript
// packages/server/src/services/pipeline/workers/SearchWorker.ts
export class SearchWorker extends BaseWorker {
  interval = 5000;      // Poll every 5 seconds
  concurrency = 3;      // Process 3 items concurrently
}
```

### Retry Configuration

**Default**: 3 attempts, exponential backoff (1m → 2m → 4m)

**Configurable per pipeline**:
```typescript
// In PipelineTemplate
{
  retry: {
    maxAttempts: 3,
    baseDelay: 60000,     // 1 minute
    maxDelay: 3600000,    // 1 hour
    exponentialBackoff: true
  }
}
```

---

## Summary

The Annex media request system is a robust, distributed pipeline that processes media through four distinct phases:

1. **Search** → Find optimal releases from indexers
2. **Download** → Download torrents with deduplication
3. **Encode** → Encode to AV1 via remote GPU encoders
4. **Deliver** → Transfer to storage and trigger library scans

Each phase is handled by dedicated workers that poll the database, process items with concurrency limits, and transition through a validated state machine. The system is:

- **Crash-resilient**: Database is single source of truth
- **Retry-aware**: Exponential backoff for transient failures
- **Progress-tracked**: Real-time updates via WebSocket
- **Granular**: Per-episode tracking for TV shows
- **Scalable**: Distributed encoders, parallel downloads

All monitoring loops run independently and handle edge cases (stuck items, stalled downloads, offline encoders) to ensure reliable end-to-end media processing.
