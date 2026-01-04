# Pipeline Cleanup: MediaRequest Refactoring Plan

**Author**: Claude
**Date**: 2026-01-02
**Status**: Proposed

---

## Executive Summary

This document outlines a comprehensive refactoring to transform MediaRequest from a bloated state-tracking model into a pure request configuration model. All pipeline execution state will be migrated to ProcessingItem and related models, establishing a clean separation of concerns:

- **MediaRequest** = User's request intent and configuration (what they want)
- **ProcessingItem** = Work units executing through pipelines (the actual work)
- **Download**, **Job**, **PipelineExecution** = Supporting execution artifacts

**Impact**: ~25 fields deleted from MediaRequest, significant code simplification, improved maintainability.

---

## Philosophy & Goals

### Core Principle
> "A MediaRequest should represent what the user asked for, not how we're processing it."

### Goals
1. **Separation of Concerns**: Request configuration vs. execution state
2. **Single Source of Truth**: ProcessingItems own their pipeline state
3. **Computed State**: MediaRequest status/progress derived from ProcessingItems
4. **Zero Duplication**: No field exists in both MediaRequest and ProcessingItem
5. **Robustness**: Make the system more resilient to crashes and restarts
6. **Simplicity**: Reduce cognitive load when debugging requests

---

## Fields to Delete from MediaRequest

### Category 1: Status & Progress Tracking (DELETE)
**These are execution state, not request configuration.**

| Field | Line | Reason | Replacement |
|-------|------|--------|-------------|
| `status` | 262 | Execution state | Computed from ProcessingItems |
| `progress` | 263 | Execution state | Computed from ProcessingItems |
| `currentStep` | 264 | Execution state | Derived from ProcessingItems |
| `currentStepStartedAt` | 265 | Execution state | Derived from ProcessingItems |
| `error` | 266 | Execution state | Aggregated from ProcessingItems |
| `totalItems` | 301 | Aggregate counter | Computed via `processingItems.count()` |
| `completedItems` | 302 | Aggregate counter | Computed via `processingItems.count({ where: { status: 'COMPLETED' }})` |
| `failedItems` | 303 | Aggregate counter | Computed via `processingItems.count({ where: { status: 'FAILED' }})` |
| `completedAt` | 298 | Execution timestamp | When all ProcessingItems complete |

**Impact**: 9 fields deleted

### Category 2: Pipeline State (DELETE)
**These are pipeline execution artifacts.**

| Field | Line | Reason | Replacement |
|-------|------|--------|-------------|
| `selectedRelease` | 269 | Pipeline artifact | Store in ProcessingItem.stepContext |
| `torrentHash` | 270 | **ALREADY DEPRECATED** | Uses Download model |
| `sourceFilePath` | 271 | **DUPLICATE** | ProcessingItem.sourceFilePath already exists |
| `encodedFiles` | 272 | Pipeline artifact | Track via Job/EncoderAssignment relations |

**Impact**: 4 fields deleted (3 effective, 1 already deprecated)

### Category 3: Release Metadata (DELETE → MOVE TO Download)
**These belong to the Download, not the Request.**

| Field | Line | Reason | Replacement |
|-------|------|--------|-------------|
| `releaseFileSize` | 275 | Download metadata | Download.size |
| `releaseIndexerName` | 276 | Download metadata | Download.indexerName (new field) |
| `releaseSeeders` | 277 | Download metadata | Download.seedCount |
| `releaseLeechers` | 278 | Download metadata | Download.peerCount |
| `releaseResolution` | 279 | Download metadata | Download.resolution (new field) |
| `releaseSource` | 280 | Download metadata | Download.source (new field) |
| `releaseCodec` | 281 | Download metadata | Download.codec (new field) |
| `releaseScore` | 282 | Download metadata | Download.qualityScore (new field) |
| `releasePublishDate` | 283 | Download metadata | Download.publishDate (new field) |
| `releaseName` | 284 | Download metadata | Download.torrentName (already exists) |

**Impact**: 10 fields deleted from MediaRequest, 8 new fields added to Download

### Category 4: Quality Tracking (DELETE)
**These are execution state, not request configuration.**

| Field | Line | Reason | Replacement |
|-------|------|--------|-------------|
| `requiredResolution` | 287 | Derived from targets | Compute from `targets` on-demand |
| `availableReleases` | 288 | **DUPLICATE** | ProcessingItem.availableReleases already exists |
| `qualitySearchedAt` | 289 | Execution timestamp | Track per-ProcessingItem if needed |

**Impact**: 3 fields deleted

### Fields to KEEP (Request Configuration)

These represent the user's request intent:

- `id`, `type`, `tmdbId`, `title`, `year` - What was requested
- `posterPath` - UI display
- `requestedSeasons`, `requestedEpisodes` - Specific request parameters
- `targets` - Where to deliver (configuration)
- `monitoring`, `subscribe` - Ongoing behavior (configuration)
- `lastCheckedAt` - Monitoring timestamp
- `userId`, `createdAt`, `updatedAt` - Metadata

**Total Deleted**: ~25 fields
**Final MediaRequest**: ~15 fields (pure configuration)

### Category 5: JSONB Columns to Normalize (REPLACE WITH RELATIONS)

**Problem**: JSONB columns are fragile - partial updates can cause data loss, no type safety, hard to query.

| Field | Line | Type | Replacement |
|-------|------|------|-------------|
| `targets` | 260 | Json | **RequestTarget** relation table |
| `requestedEpisodes` | 255 | Json | **RequestedEpisode** relation table |
| `selectedRelease` | 269 | Json | Store in ProcessingItem.stepContext (DELETE anyway) |
| `encodedFiles` | 272 | Json | Track via Job relations (DELETE anyway) |
| `availableReleases` | 288 | Json | **AlternativeRelease** relation table |

**Additional JSONB to normalize**:
- `ProcessingItem.availableReleases` → **AlternativeRelease** relation
- `ProcessingItem.stepContext` → Keep as JSONB (truly dynamic, document schema)
- `Download.alternativeReleases` → **AlternativeRelease** relation

**Impact**: 3 new relation tables, eliminate 5+ JSONB columns

---

## New Computed Properties System

Since we're deleting status/progress fields, we need efficient computed properties:

### Backend: RequestStatusComputer Service

```typescript
// packages/server/src/services/requestStatusComputer.ts

export class RequestStatusComputer {
  /**
   * Compute aggregate status from ProcessingItems
   */
  async computeStatus(requestId: string): Promise<{
    status: RequestStatus;
    progress: number;
    currentStep: string | null;
    error: string | null;
    totalItems: number;
    completedItems: number;
    failedItems: number;
  }> {
    const items = await prisma.processingItem.findMany({
      where: { requestId },
      select: { status: true, progress: true, currentStep: true, lastError: true }
    });

    // Status derivation logic (same as ProcessingItemRepository.updateRequestAggregates)
    // But this is READ-ONLY - doesn't update MediaRequest

    return {
      status: derivedStatus,
      progress: avgProgress,
      currentStep: mostCommonStep,
      error: firstError,
      totalItems: items.length,
      completedItems: items.filter(i => i.status === 'COMPLETED').length,
      failedItems: items.filter(i => i.status === 'FAILED').length,
    };
  }

  /**
   * Get release metadata from Download
   */
  async getReleaseMetadata(requestId: string): Promise<ReleaseMetadata | null> {
    const download = await prisma.download.findFirst({
      where: { requestId },
      orderBy: { createdAt: 'desc' },
      select: {
        size: true, indexerName: true, seedCount: true, peerCount: true,
        resolution: true, source: true, codec: true, qualityScore: true,
        publishDate: true, torrentName: true
      }
    });

    return download ? {
      fileSize: download.size,
      indexerName: download.indexerName,
      seeders: download.seedCount,
      leechers: download.peerCount,
      resolution: download.resolution,
      source: download.source,
      codec: download.codec,
      score: download.qualityScore,
      publishDate: download.publishDate,
      name: download.torrentName,
    } : null;
  }
}
```

### Usage in tRPC Routers

```typescript
// packages/server/src/routers/requests.ts

// BEFORE (direct field access):
const r = await prisma.mediaRequest.findUnique({ where: { id } });
return {
  status: r.status,
  progress: r.progress,
  currentStep: r.currentStep,
  releaseMetadata: { fileSize: r.releaseFileSize, ... }
};

// AFTER (computed):
const r = await prisma.mediaRequest.findUnique({ where: { id } });
const computed = await requestStatusComputer.computeStatus(id);
const releaseMetadata = await requestStatusComputer.getReleaseMetadata(id);

return {
  ...r, // Base request fields
  ...computed, // Computed status/progress
  releaseMetadata,
};
```

---

## Data Migration Strategy

### Migration File Structure

```
packages/server/prisma/migrations/
└── YYYYMMDDHHMMSS_remove_execution_state_from_media_request/
    ├── migration.sql
    ├── README.md
    └── rollback.sql (for safety)
```

### Pre-Migration: Data Audit & Backfill (CRITICAL)

**Before any schema changes**, we must handle existing data:

#### Step 1: Audit Existing Data

```sql
-- Check for requests without ProcessingItems (LEGACY DATA)
SELECT
  mr.id,
  mr.type,
  mr.status,
  mr.title,
  (SELECT COUNT(*) FROM "ProcessingItem" pi WHERE pi."requestId" = mr.id) as item_count
FROM "MediaRequest" mr
WHERE NOT EXISTS (
  SELECT 1 FROM "ProcessingItem" pi WHERE pi."requestId" = mr.id
);

-- Expected: Possibly many old requests without ProcessingItems

-- Check for in-flight requests (will break if we don't handle)
SELECT COUNT(*) FROM "MediaRequest"
WHERE status IN ('SEARCHING', 'DOWNLOADING', 'ENCODING', 'DELIVERING', 'PENDING');

-- Check for requests with stale PipelineExecution.context
SELECT COUNT(*) FROM "PipelineExecution" pe
WHERE pe.context = '{}'::jsonb OR pe.context IS NULL;
```

#### Step 2: Backfill ProcessingItems for Legacy Requests

**CRITICAL**: Create ProcessingItems for all requests that don't have them.

```sql
-- Backfill ProcessingItems for legacy MOVIE requests
INSERT INTO "ProcessingItem" (
  id, "requestId", type, "tmdbId", title, year,
  status, "currentStep", "stepContext", progress,
  "startedAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  mr.id,
  'MOVIE'::ProcessingType,
  mr."tmdbId",
  mr.title,
  mr.year,
  -- Map MediaRequest.status to ProcessingStatus
  CASE mr.status
    WHEN 'PENDING'::RequestStatus THEN 'PENDING'::ProcessingStatus
    WHEN 'SEARCHING'::RequestStatus THEN 'SEARCHING'::ProcessingStatus
    WHEN 'DOWNLOADING'::RequestStatus THEN 'DOWNLOADING'::ProcessingStatus
    WHEN 'ENCODING'::RequestStatus THEN 'ENCODING'::ProcessingStatus
    WHEN 'DELIVERING'::RequestStatus THEN 'DELIVERING'::ProcessingStatus
    WHEN 'COMPLETED'::RequestStatus THEN 'COMPLETED'::ProcessingStatus
    WHEN 'FAILED'::RequestStatus THEN 'FAILED'::ProcessingStatus
    ELSE 'PENDING'::ProcessingStatus
  END,
  mr."currentStep",
  -- Migrate selectedRelease to stepContext
  CASE
    WHEN mr."selectedRelease" IS NOT NULL THEN
      jsonb_build_object('search', jsonb_build_object('selectedRelease', mr."selectedRelease"))
    ELSE '{}'::jsonb
  END,
  mr.progress,
  mr."createdAt",
  mr."createdAt",
  mr."updatedAt"
FROM "MediaRequest" mr
WHERE mr.type = 'MOVIE'
  AND NOT EXISTS (
    SELECT 1 FROM "ProcessingItem" pi WHERE pi."requestId" = mr.id
  );

-- Backfill ProcessingItems for legacy TV requests
-- More complex: need to create items for each requested episode
DO $$
DECLARE
  req RECORD;
  ep JSONB;
  season_num INT;
BEGIN
  FOR req IN
    SELECT * FROM "MediaRequest" mr
    WHERE mr.type = 'TV'
      AND NOT EXISTS (
        SELECT 1 FROM "ProcessingItem" pi WHERE pi."requestId" = mr.id
      )
  LOOP
    -- If requestedEpisodes is specified, create items for those
    IF req."requestedEpisodes" IS NOT NULL AND req."requestedEpisodes" != 'null'::jsonb THEN
      FOR ep IN SELECT * FROM jsonb_array_elements(req."requestedEpisodes")
      LOOP
        INSERT INTO "ProcessingItem" (
          id, "requestId", type, "tmdbId", title, year,
          season, episode,
          status, progress, "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text,
          req.id,
          'EPISODE',
          req."tmdbId",
          req.title || ' S' || (ep->>'season') || 'E' || (ep->>'episode'),
          req.year,
          (ep->>'season')::int,
          (ep->>'episode')::int,
          CASE req.status
            WHEN 'COMPLETED'::RequestStatus THEN 'COMPLETED'::ProcessingStatus
            WHEN 'FAILED'::RequestStatus THEN 'FAILED'::ProcessingStatus
            ELSE 'PENDING'::ProcessingStatus
          END,
          req.progress,
          req."createdAt",
          req."updatedAt"
        );
      END LOOP;
    -- If requestedSeasons specified, create placeholder items
    ELSIF req."requestedSeasons" IS NOT NULL THEN
      FOR season_num IN SELECT unnest(req."requestedSeasons")
      LOOP
        -- Create a single placeholder item per season
        INSERT INTO "ProcessingItem" (
          id, "requestId", type, "tmdbId", title, year,
          season,
          status, progress, "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text,
          req.id,
          'SEASON',
          req."tmdbId",
          req.title || ' Season ' || season_num,
          req.year,
          season_num,
          CASE req.status
            WHEN 'COMPLETED'::RequestStatus THEN 'COMPLETED'::ProcessingStatus
            WHEN 'FAILED'::RequestStatus THEN 'FAILED'::ProcessingStatus
            ELSE 'PENDING'::ProcessingStatus
          END,
          req.progress,
          req."createdAt",
          req."updatedAt"
        );
      END LOOP;
    ELSE
      -- No episodes specified - create single placeholder
      INSERT INTO "ProcessingItem" (
        id, "requestId", type, "tmdbId", title, year,
        status, progress, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text,
        req.id,
        'EPISODE',
        req."tmdbId",
        req.title,
        req.year,
        CASE req.status
          WHEN 'COMPLETED'::RequestStatus THEN 'COMPLETED'::ProcessingStatus
          WHEN 'FAILED'::RequestStatus THEN 'FAILED'::ProcessingStatus
          ELSE 'PENDING'::ProcessingStatus
        END,
        req.progress,
        req."createdAt",
        req."updatedAt"
      );
    END IF;
  END LOOP;
END $$;

-- Verify backfill
SELECT
  'Requests without ProcessingItems' as check_name,
  COUNT(*) as count
FROM "MediaRequest" mr
WHERE NOT EXISTS (
  SELECT 1 FROM "ProcessingItem" pi WHERE pi."requestId" = mr.id
);
-- Should return 0

-- Update MediaRequest aggregate counts after backfill
UPDATE "MediaRequest" mr
SET
  "totalItems" = (SELECT COUNT(*) FROM "ProcessingItem" WHERE "requestId" = mr.id),
  "completedItems" = (SELECT COUNT(*) FROM "ProcessingItem" WHERE "requestId" = mr.id AND status = 'COMPLETED'),
  "failedItems" = (SELECT COUNT(*) FROM "ProcessingItem" WHERE "requestId" = mr.id AND status = 'FAILED');
```

#### Step 3: Validate Backfill

```sql
-- Verify all requests now have ProcessingItems
SELECT COUNT(*) FROM "MediaRequest" mr
WHERE NOT EXISTS (
  SELECT 1 FROM "ProcessingItem" pi WHERE pi."requestId" = mr.id
);
-- Must return 0 before proceeding!

-- Verify aggregate counts are correct
SELECT
  mr.id,
  mr."totalItems" as stored_total,
  (SELECT COUNT(*) FROM "ProcessingItem" WHERE "requestId" = mr.id) as actual_total,
  mr."completedItems" as stored_completed,
  (SELECT COUNT(*) FROM "ProcessingItem" WHERE "requestId" = mr.id AND status = 'COMPLETED') as actual_completed
FROM "MediaRequest" mr
WHERE mr."totalItems" != (SELECT COUNT(*) FROM "ProcessingItem" WHERE "requestId" = mr.id)
   OR mr."completedItems" != (SELECT COUNT(*) FROM "ProcessingItem" WHERE "requestId" = mr.id AND status = 'COMPLETED');
-- Should return 0 rows
```

### Phase 1: Add New Fields and Tables (Expand)

```sql
-- ============================================================================
-- STEP 1: Add new fields to Download model
-- ============================================================================
ALTER TABLE "Download" ADD COLUMN "indexerName" TEXT;
ALTER TABLE "Download" ADD COLUMN "resolution" TEXT;
ALTER TABLE "Download" ADD COLUMN "source" TEXT;
ALTER TABLE "Download" ADD COLUMN "codec" TEXT;
ALTER TABLE "Download" ADD COLUMN "qualityScore" INTEGER;
ALTER TABLE "Download" ADD COLUMN "publishDate" TIMESTAMP(3);

-- Migrate data from MediaRequest to Download
UPDATE "Download" d
SET
  "indexerName" = mr."releaseIndexerName",
  "resolution" = mr."releaseResolution",
  "source" = mr."releaseSource",
  "codec" = mr."releaseCodec",
  "qualityScore" = mr."releaseScore",
  "publishDate" = mr."releasePublishDate"
FROM "MediaRequest" mr
WHERE d."requestId" = mr."id"
  AND mr."releaseIndexerName" IS NOT NULL;

-- ============================================================================
-- STEP 2: Create new relation tables to replace JSONB columns
-- ============================================================================

-- RequestTarget table (replaces MediaRequest.targets JSON)
CREATE TABLE "RequestTarget" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "encodingProfileId" TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RequestTarget_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE,
  CONSTRAINT "RequestTarget_serverId_fkey"
    FOREIGN KEY ("serverId") REFERENCES "StorageServer"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "RequestTarget_requestId_serverId_key"
  ON "RequestTarget"("requestId", "serverId");
CREATE INDEX "RequestTarget_requestId_idx" ON "RequestTarget"("requestId");
CREATE INDEX "RequestTarget_serverId_idx" ON "RequestTarget"("serverId");

-- RequestedEpisode table (replaces MediaRequest.requestedEpisodes JSON)
CREATE TABLE "RequestedEpisode" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestId" TEXT NOT NULL,
  "season" INTEGER NOT NULL,
  "episode" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RequestedEpisode_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "RequestedEpisode_requestId_season_episode_key"
  ON "RequestedEpisode"("requestId", "season", "episode");
CREATE INDEX "RequestedEpisode_requestId_idx" ON "RequestedEpisode"("requestId");

-- AlternativeRelease table (replaces availableReleases JSON in multiple places)
CREATE TABLE "AlternativeRelease" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestId" TEXT,
  "processingItemId" TEXT,
  "title" TEXT NOT NULL,
  "indexerId" TEXT NOT NULL,
  "indexerName" TEXT NOT NULL,
  "resolution" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "codec" TEXT NOT NULL,
  "size" BIGINT NOT NULL,
  "seeders" INTEGER NOT NULL,
  "leechers" INTEGER NOT NULL,
  "magnetUri" TEXT,
  "downloadUrl" TEXT,
  "infoUrl" TEXT,
  "publishDate" TIMESTAMP(3) NOT NULL,
  "score" INTEGER NOT NULL,
  "rank" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AlternativeRelease_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE,
  CONSTRAINT "AlternativeRelease_processingItemId_fkey"
    FOREIGN KEY ("processingItemId") REFERENCES "ProcessingItem"("id") ON DELETE CASCADE
);

CREATE INDEX "AlternativeRelease_requestId_idx" ON "AlternativeRelease"("requestId");
CREATE INDEX "AlternativeRelease_processingItemId_idx" ON "AlternativeRelease"("processingItemId");
CREATE INDEX "AlternativeRelease_requestId_rank_idx" ON "AlternativeRelease"("requestId", "rank");
CREATE INDEX "AlternativeRelease_processingItemId_rank_idx" ON "AlternativeRelease"("processingItemId", "rank");

-- ============================================================================
-- STEP 3: Migrate JSONB data to relation tables
-- ============================================================================

-- Migrate MediaRequest.targets JSON → RequestTarget table
DO $$
DECLARE
  r RECORD;
  target JSONB;
  target_order INT;
BEGIN
  FOR r IN SELECT id, targets FROM "MediaRequest" WHERE targets IS NOT NULL AND targets != 'null'::jsonb
  LOOP
    target_order := 0;
    FOR target IN SELECT * FROM jsonb_array_elements(r.targets)
    LOOP
      INSERT INTO "RequestTarget" (id, "requestId", "serverId", "encodingProfileId", "order")
      VALUES (
        gen_random_uuid()::text,
        r.id,
        target->>'serverId',
        target->>'encodingProfileId',
        target_order
      )
      ON CONFLICT ("requestId", "serverId") DO NOTHING;

      target_order := target_order + 1;
    END LOOP;
  END LOOP;
END $$;

-- Migrate MediaRequest.requestedEpisodes JSON → RequestedEpisode table
DO $$
DECLARE
  r RECORD;
  ep JSONB;
BEGIN
  FOR r IN SELECT id, "requestedEpisodes" FROM "MediaRequest"
    WHERE "requestedEpisodes" IS NOT NULL AND "requestedEpisodes" != 'null'::jsonb
  LOOP
    FOR ep IN SELECT * FROM jsonb_array_elements(r."requestedEpisodes")
    LOOP
      INSERT INTO "RequestedEpisode" (id, "requestId", season, episode)
      VALUES (
        gen_random_uuid()::text,
        r.id,
        (ep->>'season')::int,
        (ep->>'episode')::int
      )
      ON CONFLICT ("requestId", season, episode) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- Migrate MediaRequest.availableReleases JSON → AlternativeRelease table
DO $$
DECLARE
  r RECORD;
  release JSONB;
  rel_rank INT;
BEGIN
  FOR r IN SELECT id, "availableReleases" FROM "MediaRequest"
    WHERE "availableReleases" IS NOT NULL AND "availableReleases" != 'null'::jsonb
  LOOP
    rel_rank := 0;
    FOR release IN SELECT * FROM jsonb_array_elements(r."availableReleases")
    LOOP
      INSERT INTO "AlternativeRelease" (
        id, "requestId", title, "indexerId", "indexerName", resolution,
        source, codec, size, seeders, leechers, "magnetUri", "downloadUrl",
        "infoUrl", "publishDate", score, rank
      )
      VALUES (
        gen_random_uuid()::text,
        r.id,
        release->>'title',
        release->>'indexerId',
        release->>'indexerName',
        release->>'resolution',
        release->>'source',
        release->>'codec',
        (release->>'size')::bigint,
        (release->>'seeders')::int,
        (release->>'leechers')::int,
        release->>'magnetUri',
        release->>'downloadUrl',
        release->>'infoUrl',
        (release->>'publishDate')::timestamp,
        (release->>'score')::int,
        rel_rank
      );

      rel_rank := rel_rank + 1;
    END LOOP;
  END LOOP;
END $$;

-- Migrate ProcessingItem.availableReleases JSON → AlternativeRelease table
DO $$
DECLARE
  r RECORD;
  release JSONB;
  rel_rank INT;
BEGIN
  FOR r IN SELECT id, "availableReleases" FROM "ProcessingItem"
    WHERE "availableReleases" IS NOT NULL AND "availableReleases" != 'null'::jsonb
  LOOP
    rel_rank := 0;
    FOR release IN SELECT * FROM jsonb_array_elements(r."availableReleases")
    LOOP
      INSERT INTO "AlternativeRelease" (
        id, "processingItemId", title, "indexerId", "indexerName", resolution,
        source, codec, size, seeders, leechers, "magnetUri", "downloadUrl",
        "infoUrl", "publishDate", score, rank
      )
      VALUES (
        gen_random_uuid()::text,
        r.id,
        release->>'title',
        release->>'indexerId',
        release->>'indexerName',
        release->>'resolution',
        release->>'source',
        release->>'codec',
        (release->>'size')::bigint,
        (release->>'seeders')::int,
        (release->>'leechers')::int,
        release->>'magnetUri',
        release->>'downloadUrl',
        release->>'infoUrl',
        (release->>'publishDate')::timestamp,
        (release->>'score')::int,
        rel_rank
      );

      rel_rank := rel_rank + 1;
    END LOOP;
  END LOOP;
END $$;

-- Verify migrations
SELECT
  (SELECT COUNT(*) FROM "RequestTarget") as target_count,
  (SELECT COUNT(*) FROM "RequestedEpisode") as episode_count,
  (SELECT COUNT(*) FROM "AlternativeRelease") as alternative_count;
```

**Validation Queries**:
```sql
-- Verify all MediaRequest.targets migrated
SELECT COUNT(*) FROM "MediaRequest" mr
WHERE jsonb_array_length(mr.targets) > 0
  AND NOT EXISTS (
    SELECT 1 FROM "RequestTarget" rt WHERE rt."requestId" = mr.id
  );
-- Should return 0

-- Verify all requestedEpisodes migrated
SELECT COUNT(*) FROM "MediaRequest" mr
WHERE mr."requestedEpisodes" IS NOT NULL
  AND mr."requestedEpisodes" != 'null'::jsonb
  AND NOT EXISTS (
    SELECT 1 FROM "RequestedEpisode" re WHERE re."requestId" = mr.id
  );
-- Should return 0

-- Verify AlternativeReleases migrated
SELECT COUNT(*) FROM "MediaRequest" mr
WHERE jsonb_array_length(mr."availableReleases") > 0
  AND NOT EXISTS (
    SELECT 1 FROM "AlternativeRelease" ar WHERE ar."requestId" = mr.id
  );
-- Should return 0
```

### Phase 2: Deploy Code Changes (Contract)

Deploy code that:
1. Reads from new Download fields instead of MediaRequest
2. Uses computed properties for status/progress
3. Stops writing to old MediaRequest fields

**Critical**: Code must work with BOTH old and new schema during this phase.

#### Backwards Compatibility Layer

To ensure zero-downtime deployment, add fallback logic:

```typescript
// RequestStatusComputer - handle requests without ProcessingItems
async computeStatus(requestId: string): Promise<ComputedRequestStatus> {
  const items = await prisma.processingItem.findMany({
    where: { requestId },
    select: { status: true, progress: true, currentStep: true, lastError: true, updatedAt: true },
  });

  // BACKWARDS COMPATIBILITY: If no ProcessingItems, fall back to MediaRequest fields
  if (items.length === 0) {
    const request = await prisma.mediaRequest.findUnique({
      where: { id: requestId },
      select: {
        status: true,
        progress: true,
        currentStep: true,
        error: true,
        totalItems: true,
        completedItems: true,
        failedItems: true,
        updatedAt: true,
      },
    });

    if (!request) {
      throw new Error(`Request ${requestId} not found`);
    }

    // Return data from old fields (will be migrated soon)
    return {
      status: request.status as RequestStatus,
      progress: request.progress,
      currentStep: request.currentStep,
      currentStepStartedAt: request.updatedAt,
      error: request.error,
      totalItems: request.totalItems,
      completedItems: request.completedItems,
      failedItems: request.failedItems,
    };
  }

  // Normal path: compute from ProcessingItems
  // ... existing logic ...
}

// Similar fallback in getReleaseMetadata
async getReleaseMetadata(requestId: string): Promise<ReleaseMetadata | null> {
  // Try Download first
  const download = await prisma.download.findFirst({
    where: { requestId },
    orderBy: { createdAt: 'desc' },
    select: { /* new fields */ },
  });

  if (download?.indexerName) {
    return { /* from Download */ };
  }

  // BACKWARDS COMPATIBILITY: Fall back to MediaRequest fields
  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
    select: {
      releaseFileSize: true,
      releaseIndexerName: true,
      // ... all old release fields
    },
  });

  if (!request?.releaseIndexerName) {
    return null;
  }

  // Map old fields to new structure
  return {
    fileSize: Number(request.releaseFileSize || 0),
    indexerName: request.releaseIndexerName,
    seeders: request.releaseSeeders,
    leechers: request.releaseLeechers,
    resolution: request.releaseResolution,
    source: request.releaseSource,
    codec: request.releaseCodec,
    score: request.releaseScore,
    publishDate: request.releasePublishDate,
    name: request.releaseName,
    episodeCount: null,
  };
}
```

#### Deployment Safety Checks

Before deploying Phase 2 code:

```sql
-- Verify all active requests have ProcessingItems
SELECT mr.id, mr.title, mr.status
FROM "MediaRequest" mr
WHERE mr.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
  AND NOT EXISTS (
    SELECT 1 FROM "ProcessingItem" pi WHERE pi."requestId" = mr.id
  );
-- Should return 0 rows

-- Verify RequestTarget migration completed
SELECT COUNT(*) FROM "MediaRequest" mr
WHERE jsonb_array_length(mr.targets) > 0
  AND NOT EXISTS (
    SELECT 1 FROM "RequestTarget" rt WHERE rt."requestId" = mr.id
  );
-- Should return 0

-- Verify no data loss in JSONB migration
SELECT
  (SELECT COUNT(*) FROM "MediaRequest" WHERE targets IS NOT NULL AND targets != '[]'::jsonb) as requests_with_targets,
  (SELECT COUNT(DISTINCT "requestId") FROM "RequestTarget") as requests_migrated;
-- Numbers should match
```

### Phase 3: Remove Old Fields (Cleanup)

```sql
-- ============================================================================
-- Drop deprecated execution state fields from MediaRequest
-- ============================================================================
ALTER TABLE "MediaRequest" DROP COLUMN "status";
ALTER TABLE "MediaRequest" DROP COLUMN "progress";
ALTER TABLE "MediaRequest" DROP COLUMN "currentStep";
ALTER TABLE "MediaRequest" DROP COLUMN "currentStepStartedAt";
ALTER TABLE "MediaRequest" DROP COLUMN "error";
ALTER TABLE "MediaRequest" DROP COLUMN "selectedRelease";
ALTER TABLE "MediaRequest" DROP COLUMN "torrentHash";
ALTER TABLE "MediaRequest" DROP COLUMN "sourceFilePath";
ALTER TABLE "MediaRequest" DROP COLUMN "encodedFiles";
ALTER TABLE "MediaRequest" DROP COLUMN "releaseFileSize";
ALTER TABLE "MediaRequest" DROP COLUMN "releaseIndexerName";
ALTER TABLE "MediaRequest" DROP COLUMN "releaseSeeders";
ALTER TABLE "MediaRequest" DROP COLUMN "releaseLeechers";
ALTER TABLE "MediaRequest" DROP COLUMN "releaseResolution";
ALTER TABLE "MediaRequest" DROP COLUMN "releaseSource";
ALTER TABLE "MediaRequest" DROP COLUMN "releaseCodec";
ALTER TABLE "MediaRequest" DROP COLUMN "releaseScore";
ALTER TABLE "MediaRequest" DROP COLUMN "releasePublishDate";
ALTER TABLE "MediaRequest" DROP COLUMN "releaseName";
ALTER TABLE "MediaRequest" DROP COLUMN "requiredResolution";
ALTER TABLE "MediaRequest" DROP COLUMN "qualitySearchedAt";
ALTER TABLE "MediaRequest" DROP COLUMN "totalItems";
ALTER TABLE "MediaRequest" DROP COLUMN "completedItems";
ALTER TABLE "MediaRequest" DROP COLUMN "failedItems";
ALTER TABLE "MediaRequest" DROP COLUMN "completedAt";

-- ============================================================================
-- Drop JSONB columns now replaced by relation tables
-- ============================================================================
ALTER TABLE "MediaRequest" DROP COLUMN "targets";
ALTER TABLE "MediaRequest" DROP COLUMN "requestedEpisodes";
ALTER TABLE "MediaRequest" DROP COLUMN "availableReleases";

ALTER TABLE "ProcessingItem" DROP COLUMN "availableReleases";

ALTER TABLE "Download" DROP COLUMN "alternativeReleases";

-- Verify final MediaRequest schema is clean
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'MediaRequest'
ORDER BY ordinal_position;
```

### Rollback Plan

#### Phase 1 Rollback (Expand phase)
If issues found after adding new fields/tables:
- **Safe**: New fields/tables are unused, can be dropped
- No data loss risk
- Simply drop new tables and columns

```sql
DROP TABLE IF EXISTS "AlternativeRelease";
DROP TABLE IF EXISTS "RequestedEpisode";
DROP TABLE IF EXISTS "RequestTarget";

ALTER TABLE "Download" DROP COLUMN IF EXISTS "indexerName";
ALTER TABLE "Download" DROP COLUMN IF EXISTS "resolution";
-- ... etc
```

#### Phase 2 Rollback (Contract phase)
If issues found after deploying new code:
- **Data preserved**: Old MediaRequest fields still exist
- Revert code deployment
- Old code continues working with old fields

**Critical**: DO NOT proceed to Phase 3 until Phase 2 is stable in production for at least 1 week.

#### Phase 3 Rollback (Cleanup phase)
If issues found after dropping old columns:
- **CRITICAL**: Data loss has occurred
- Must restore from database backup
- Re-run Phase 1 migration to recreate new tables
- Re-run backfill scripts

**Rollback migration** (emergency only):
```sql
-- Restore dropped columns (structure only, data lost!)
ALTER TABLE "MediaRequest" ADD COLUMN "status" "RequestStatus" DEFAULT 'PENDING';
ALTER TABLE "MediaRequest" ADD COLUMN "progress" DOUBLE PRECISION DEFAULT 0;
-- ... add all dropped columns back

-- Repopulate from ProcessingItems
UPDATE "MediaRequest" mr
SET
  status = (
    SELECT CASE
      WHEN COUNT(*) = 0 THEN 'PENDING'
      WHEN COUNT(*) FILTER (WHERE pi.status = 'COMPLETED') = COUNT(*) THEN 'COMPLETED'
      WHEN COUNT(*) FILTER (WHERE pi.status = 'FAILED') = COUNT(*) THEN 'FAILED'
      -- ... derive from ProcessingItems
    END
    FROM "ProcessingItem" pi WHERE pi."requestId" = mr.id
  ),
  progress = (
    SELECT COALESCE(AVG(pi.progress), 0)
    FROM "ProcessingItem" pi WHERE pi."requestId" = mr.id
  );
-- ... repopulate all fields
```

**Prevention**:
1. Take full database backup before Phase 3
2. Keep backup for at least 30 days
3. Test rollback procedure on staging first

---

## Backend Changes Required

### 1. Prisma Schema Changes

**File**: `packages/server/prisma/schema.prisma`

```prisma
model MediaRequest {
  id       String    @id @default(cuid())
  type     MediaType
  tmdbId   Int
  title    String
  year     Int
  posterPath String?

  // Request parameters
  requestedSeasons  Int[]
  // REMOVED: requestedEpisodes Json - replaced with RequestedEpisode relation
  // REMOVED: targets Json - replaced with RequestTarget relation

  // Ongoing behavior
  monitoring    Boolean   @default(false) // DEPRECATED - use subscribe
  subscribe     Boolean   @default(false)
  lastCheckedAt DateTime?

  // Metadata
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Relations
  user               User?               @relation(fields: [userId], references: [id], onDelete: SetNull)
  userId             String?
  activityLog        ActivityLog[]
  downloads          Download[]
  jobs               Job[]
  pipelineExecutions PipelineExecution[]
  processingItems    ProcessingItem[]
  approvalQueue      ApprovalQueue[]
  targets            RequestTarget[]     // NEW: Strongly-typed targets
  requestedEpisodes  RequestedEpisode[]  // NEW: Strongly-typed episodes

  @@index([userId])
  @@index([monitoring, type])
  @@index([createdAt])
}

// NEW: Request target configuration (replaces MediaRequest.targets JSON)
model RequestTarget {
  id        String @id @default(cuid())
  requestId String
  request   MediaRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)

  serverId String
  server   StorageServer @relation(fields: [serverId], references: [id], onDelete: Cascade)

  // Optional per-target encoding profile override
  encodingProfileId String?

  // Order for deterministic processing
  order Int @default(0)

  createdAt DateTime @default(now())

  @@unique([requestId, serverId])
  @@index([requestId])
  @@index([serverId])
}

// NEW: Requested episodes for TV shows (replaces MediaRequest.requestedEpisodes JSON)
model RequestedEpisode {
  id        String @id @default(cuid())
  requestId String
  request   MediaRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)

  season  Int
  episode Int

  createdAt DateTime @default(now())

  @@unique([requestId, season, episode])
  @@index([requestId])
}

// NEW: Alternative releases for quality fallback (replaces availableReleases JSON)
model AlternativeRelease {
  id String @id @default(cuid())

  // Can belong to either MediaRequest or ProcessingItem
  requestId        String?
  request          MediaRequest? @relation(fields: [requestId], references: [id], onDelete: Cascade)
  processingItemId String?
  processingItem   ProcessingItem? @relation(fields: [processingItemId], references: [id], onDelete: Cascade)

  // Release details
  title       String
  indexerId   String
  indexerName String
  resolution  String
  source      String
  codec       String
  size        BigInt
  seeders     Int
  leechers    Int
  magnetUri   String?
  downloadUrl String?
  infoUrl     String?
  publishDate DateTime
  score       Int

  // For ordering alternatives by quality
  rank Int @default(0)

  createdAt DateTime @default(now())

  @@index([requestId])
  @@index([processingItemId])
  @@index([requestId, rank])
  @@index([processingItemId, rank])
}

model Download {
  id        String       @id @default(cuid())
  requestId String
  request   MediaRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)

  // qBittorrent tracking
  torrentHash String  @unique
  torrentName String
  magnetUri   String?

  // Paths
  savePath    String?
  contentPath String?

  // Status & Progress
  status        DownloadStatus @default(PENDING)
  progress      Float          @default(0)
  size          BigInt?
  error         String?
  failureReason String?

  // Type info
  mediaType    MediaType
  isSeasonPack Boolean   @default(false)
  season       Int?

  // Release metadata (NEW - migrated from MediaRequest)
  indexerName  String?
  resolution   String?  // e.g., "1080p", "2160p"
  source       String?  // e.g., "BluRay", "WEB-DL"
  codec        String?  // e.g., "HEVC", "H264"
  qualityScore Int?     // Quality scoring
  publishDate  DateTime?

  // Retry tracking
  attemptCount        Int       @default(1)
  lastAttemptAt       DateTime?
  // REMOVED: alternativeReleases Json - replaced with AlternativeRelease relation

  // Health tracking
  lastProgressAt DateTime?
  seedCount      Int?
  peerCount      Int?

  // Timestamps
  startedAt   DateTime?
  completedAt DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  // Relations
  processingItems ProcessingItem[]
  events          DownloadEvent[]

  @@index([requestId])
  @@index([status])
  @@index([mediaType, status])
}

model ProcessingItem {
  id        String @id @default(cuid())
  requestId String

  // What we're processing
  type    ProcessingType
  tmdbId  Int
  title   String
  year    Int?
  season  Int? // For EPISODE type only
  episode Int? // For EPISODE type only

  // Pipeline state
  status      ProcessingStatus
  currentStep String?
  stepContext Json             @default("{}") // Keep as JSON - truly dynamic step data

  // Retry handling
  attempts    Int       @default(0)
  maxAttempts Int       @default(5)
  lastError   String?
  nextRetryAt DateTime?

  // Progress tracking
  progress    Int       @default(0) // 0-100
  startedAt   DateTime  @default(now())
  completedAt DateTime?

  // External references
  downloadId    String?
  encodingJobId String?

  // Episode-specific tracking fields
  sourceFilePath    String?
  airDate           DateTime?
  downloadedAt      DateTime?
  encodedAt         DateTime?
  deliveredAt       DateTime?
  qualityMet        Boolean   @default(false)
  // REMOVED: availableReleases Json - replaced with AlternativeRelease relation

  // Relations
  request             MediaRequest         @relation(fields: [requestId], references: [id], onDelete: Cascade)
  download            Download?            @relation(fields: [downloadId], references: [id], onDelete: SetNull)
  alternativeReleases AlternativeRelease[] // NEW: Strongly-typed alternatives

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([requestId])
  @@index([status])
  @@index([status, nextRetryAt])
  @@index([requestId, status])
  @@index([type, status])
}
```

**Changes Summary**:
- MediaRequest: Remove JSON columns, add 3 relation tables
- Download: Remove `alternativeReleases` JSON
- ProcessingItem: Remove `availableReleases` JSON
- Keep `stepContext` as JSON (document schema in code comments)

**Changes**:
- MediaRequest: Remove ~25 fields
- Download: Add 6 new fields for release metadata

### 2. Router Changes

**File**: `packages/server/src/routers/requests.ts`

#### Changes to `list` endpoint (lines 406-605):

**BEFORE**:
```typescript
select: {
  id: true,
  // ... base fields ...
  status: true,                    // DELETE
  progress: true,                  // DELETE
  currentStep: true,               // DELETE
  currentStepStartedAt: true,      // DELETE
  error: true,                     // DELETE
  requiredResolution: true,        // DELETE
  availableReleases: true,         // DELETE
  qualitySearchedAt: true,         // DELETE
  completedAt: true,               // DELETE
  releaseFileSize: true,           // DELETE
  releaseIndexerName: true,        // DELETE
  // ... all release* fields DELETE
}
```

**AFTER**:
```typescript
select: {
  id: true,
  type: true,
  tmdbId: true,
  title: true,
  year: true,
  posterPath: true,
  targets: true,
  requestedSeasons: true,
  requestedEpisodes: true,
  processingItems: {
    select: {
      id: true,
      type: true,
      status: true,
      progress: true,
      season: true,
      episode: true,
      currentStep: true,
      attempts: true,
      lastError: true,
    },
  },
  downloads: {
    select: {
      indexerName: true,
      resolution: true,
      source: true,
      codec: true,
      qualityScore: true,
      publishDate: true,
      torrentName: true,
      size: true,
    },
    take: 1,
    orderBy: { createdAt: 'desc' },
  },
  createdAt: true,
  updatedAt: true,
}

// Then compute status after fetching
const resultsWithStatus = await Promise.all(results.map(async (r) => {
  const computed = await requestStatusComputer.computeStatus(r.id);
  return {
    ...r,
    ...computed, // status, progress, currentStep, error, etc.
    releaseMetadata: r.downloads[0] || null,
  };
}));
```

#### Changes to `get` endpoint (lines 610-701):

Similar pattern - fetch base request + processingItems + downloads, then compute.

#### Changes to `createMovie` (lines 117-156):

**REPLACE** JSONB targets with RequestTarget relations:

**BEFORE**:
```typescript
const request = await prisma.mediaRequest.create({
  data: {
    type: MediaType.MOVIE,
    tmdbId: input.tmdbId,
    title: input.title,
    year: input.year,
    posterPath: input.posterPath ?? null,
    targets: input.targets as unknown as Prisma.JsonArray, // BAD: JSONB
    selectedRelease: input.selectedRelease // BAD: JSONB
      ? (input.selectedRelease as unknown as Prisma.JsonObject)
      : undefined,
  },
});
```

**AFTER**:
```typescript
// Create request using orchestrator (already handles ProcessingItems)
const { requestId, items } = await pipelineOrchestrator.createRequest({
  type: "movie",
  tmdbId: input.tmdbId,
  title: input.title,
  year: input.year,
  targetServers: input.targets.map((t) => t.serverId),
});

// Update with metadata
await prisma.mediaRequest.update({
  where: { id: requestId },
  data: {
    posterPath: input.posterPath ?? null,
  },
});

// Create RequestTarget relations (strongly-typed)
await prisma.requestTarget.createMany({
  data: input.targets.map((target, index) => ({
    requestId,
    serverId: target.serverId,
    encodingProfileId: target.encodingProfileId,
    order: index,
  })),
});

// Store selectedRelease in ProcessingItem context if provided
if (input.selectedRelease) {
  await pipelineOrchestrator.updateContext(items[0].id, {
    search: { selectedRelease: input.selectedRelease }
  });
}
```

#### Changes to `createTv` (lines 161-401):

**REPLACE** JSONB with relations:

**BEFORE**:
```typescript
const request = await prisma.mediaRequest.create({
  data: {
    type: MediaType.TV,
    tmdbId: input.tmdbId,
    title: input.title,
    year: input.year,
    posterPath: input.posterPath ?? null,
    requestedSeasons: input.seasons ?? [],
    requestedEpisodes: input.episodes ?? Prisma.JsonNull, // BAD: JSONB
    targets: input.targets as unknown as Prisma.JsonArray, // BAD: JSONB
    status: RequestStatus.PENDING,
    progress: 0,
    subscribe: input.subscribe ?? false,
    selectedRelease: input.selectedRelease
      ? (input.selectedRelease as unknown as Prisma.JsonObject)
      : undefined,
  },
});
```

**AFTER**:
```typescript
// Use orchestrator to create request + ProcessingItems
const { requestId, items } = await pipelineOrchestrator.createRequest({
  type: "tv",
  tmdbId: input.tmdbId,
  title: input.title,
  year: input.year,
  episodes: episodesToCreate.map((ep) => ({
    season: ep.season,
    episode: ep.episode,
    title: ep.title || `Episode ${ep.episode}`,
  })),
  targetServers: input.targets.map((t) => t.serverId),
});

// Update with metadata
await prisma.mediaRequest.update({
  where: { id: requestId },
  data: {
    posterPath: input.posterPath ?? null,
    requestedSeasons: input.seasons ?? [],
    subscribe: input.subscribe ?? false,
  },
});

// Create strongly-typed relations
await Promise.all([
  // RequestTarget relations
  prisma.requestTarget.createMany({
    data: input.targets.map((target, index) => ({
      requestId,
      serverId: target.serverId,
      encodingProfileId: target.encodingProfileId,
      order: index,
    })),
  }),

  // RequestedEpisode relations (if specific episodes)
  input.episodes && input.episodes.length > 0
    ? prisma.requestedEpisode.createMany({
        data: input.episodes.map((ep) => ({
          requestId,
          season: ep.season,
          episode: ep.episode,
        })),
      })
    : Promise.resolve(),
]);

// Store selectedRelease in ProcessingItem context if provided
if (input.selectedRelease) {
  await pipelineOrchestrator.updateContext(items[0].id, {
    search: { selectedRelease: input.selectedRelease }
  });
}
```

#### Changes to `retry` (lines 785-914):

**DELETE** lines 817-901 (direct status manipulation):
```typescript
// Remove direct status updates
await prisma.mediaRequest.update({
  where: { id: input.id },
  data: {
    status,
    progress,
    currentStep,
    error: null,
  },
});
```

**REPLACE** with ProcessingItem-based retry:
```typescript
// Reset ProcessingItems to retry state
const items = await prisma.processingItem.findMany({
  where: { requestId: input.id, status: { in: ['FAILED', 'CANCELLED'] } }
});

for (const item of items) {
  await pipelineOrchestrator.retry(item.id);
}
```

#### Changes to `acceptLowerQuality` (lines 1217-1289):

**DELETE** lines 1245-1268 (release metadata storage in MediaRequest):
```typescript
// Remove this entire block - release metadata goes to Download
data: {
  status: RequestStatus.PENDING,
  selectedRelease: selectedRelease as Prisma.JsonObject,
  releaseFileSize: ...,          // DELETE
  releaseIndexerName: ...,       // DELETE
  releaseSeeders: ...,           // DELETE
  // ... all release fields DELETE
}
```

**REPLACE** with Download creation or ProcessingItem context:
```typescript
// Store selected release in ProcessingItem context
const item = await prisma.processingItem.findFirst({
  where: { requestId: input.id }
});
await pipelineOrchestrator.updateContext(item.id, {
  search: { selectedRelease }
});
```

#### Changes to `getAlternatives` (lines 1189-1212):

**BEFORE** (JSONB):
```typescript
const request = await prisma.mediaRequest.findUnique({
  where: { id: input.id },
  select: {
    status: true,
    requiredResolution: true,
    availableReleases: true,  // BAD: JSONB
    title: true,
    year: true,
    type: true,
  },
});

return {
  status: fromRequestStatus(request.status),
  requiredResolution: request.requiredResolution,
  availableReleases: request.availableReleases as unknown[] | null,
  title: request.title,
  year: request.year,
  type: fromMediaType(request.type),
};
```

**AFTER** (strongly-typed relations):
```typescript
const request = await prisma.mediaRequest.findUnique({
  where: { id: input.id },
  select: {
    title: true,
    year: true,
    type: true,
    targets: {
      include: { server: { select: { maxResolution: true } } }
    },
    alternativeReleases: {
      orderBy: { rank: 'asc' },
      select: {
        id: true,
        title: true,
        indexerId: true,
        indexerName: true,
        resolution: true,
        source: true,
        codec: true,
        size: true,
        seeders: true,
        leechers: true,
        magnetUri: true,
        downloadUrl: true,
        infoUrl: true,
        publishDate: true,
        score: true,
      },
    },
  },
});

const computed = await requestStatusComputer.computeStatus(input.id);
const requiredResolution = await deriveRequiredResolution(
  request.targets.map(t => ({ serverId: t.serverId }))
);

return {
  status: computed.status,
  requiredResolution,
  availableReleases: request.alternativeReleases, // Now strongly-typed!
  title: request.title,
  year: request.year,
  type: request.type,
};
```

### 3. Pipeline Service Changes

**Files**:
- `packages/server/src/services/pipeline/steps/SearchStep.ts`
- `packages/server/src/services/pipeline/steps/DownloadStep.ts`
- `packages/server/src/services/pipeline/steps/EncodeStep.ts`
- `packages/server/src/services/pipeline/steps/DeliverStep.ts`

#### SearchStep.ts Changes:

**Lines 129-152 - DELETE direct MediaRequest.selectedRelease access**:
```typescript
// BEFORE
const existingRequest = await prisma.mediaRequest.findUnique({
  where: { id: requestId },
  select: { selectedRelease: true },
});

if (existingRequest?.selectedRelease) {
  return {
    success: true,
    nextStep: "download",
    data: { search: { selectedRelease: existingRequest.selectedRelease } },
  };
}
```

**AFTER** - Check ProcessingItem.stepContext instead:
```typescript
// Check ProcessingItem for existing selected release
const item = await prisma.processingItem.findFirst({
  where: { requestId },
  select: { stepContext: true },
});

const searchContext = (item?.stepContext as any)?.search;
if (searchContext?.selectedRelease) {
  return {
    success: true,
    nextStep: "download",
    data: { search: { selectedRelease: searchContext.selectedRelease } },
  };
}
```

**Lines 154-174 - REMOVE MediaRequest status updates**:
```typescript
// DELETE these direct updates to MediaRequest
await prisma.mediaRequest.update({
  where: { id: requestId },
  data: {
    status: RequestStatus.SEARCHING,      // DELETE
    progress: 5,                           // DELETE
    currentStep: "Checking...",            // DELETE
    currentStepStartedAt: new Date(),      // DELETE
  },
});

await prisma.mediaRequest.update({
  where: { id: requestId },
  data: { requiredResolution },  // DELETE
});
```

**REPLACE** with ProcessingItem updates via orchestrator:
```typescript
// Update via orchestrator (which updates ProcessingItems)
await pipelineOrchestrator.transitionStatus(processingItemId, 'SEARCHING', {
  currentStep: "Checking for existing downloads...",
  progress: 5,
});
```

**Similar pattern applies to DownloadStep, EncodeStep, DeliverStep** - replace all direct MediaRequest updates with ProcessingItem updates via orchestrator.

#### DownloadStep.ts - Release Metadata Storage:

When creating Download record, capture release metadata:

```typescript
const download = await prisma.download.create({
  data: {
    requestId,
    torrentHash,
    torrentName: release.title,
    magnetUri: release.magnetUri,
    mediaType,
    // NEW: Capture release metadata
    indexerName: release.indexerName,
    resolution: release.resolution,
    source: release.source,
    codec: release.codec,
    qualityScore: release.score,
    publishDate: new Date(release.publishDate),
    size: BigInt(release.size),
    seedCount: release.seeders,
    peerCount: release.leechers,
  },
});
```

### 4. ProcessingItemRepository Changes

**File**: `packages/server/src/services/pipeline/ProcessingItemRepository.ts`

**Lines 241-292 - Keep but mark as internal**:

The `updateRequestAggregates` method is fine - it computes and writes aggregate status to MediaRequest. But we should:

1. Rename to `_updateRequestAggregatesLegacy` (mark as internal)
2. Eventually deprecate in favor of read-only computed properties
3. For now, keep it to maintain backwards compatibility during migration

**Why keep it temporarily?**
- Some parts of the system may still expect MediaRequest.status to exist
- Allows gradual migration
- Once all code uses computed properties, we can remove this

### 5. New RequestStatusComputer Service

**File**: `packages/server/src/services/requestStatusComputer.ts` (NEW)

```typescript
import { ProcessingStatus, RequestStatus } from "@prisma/client";
import { prisma } from "../db/client.js";

export interface ComputedRequestStatus {
  status: RequestStatus;
  progress: number;
  currentStep: string | null;
  currentStepStartedAt: Date | null;
  error: string | null;
  totalItems: number;
  completedItems: number;
  failedItems: number;
}

export interface ReleaseMetadata {
  fileSize: number;
  indexerName: string | null;
  seeders: number | null;
  leechers: number | null;
  resolution: string | null;
  source: string | null;
  codec: string | null;
  score: number | null;
  publishDate: Date | null;
  name: string | null;
  episodeCount: number | null;
}

export class RequestStatusComputer {
  /**
   * Compute aggregate status from ProcessingItems (READ-ONLY)
   * This does NOT update MediaRequest - use for API responses only
   */
  async computeStatus(requestId: string): Promise<ComputedRequestStatus> {
    const items = await prisma.processingItem.findMany({
      where: { requestId },
      select: {
        status: true,
        progress: true,
        currentStep: true,
        lastError: true,
        updatedAt: true,
      },
    });

    if (items.length === 0) {
      return {
        status: RequestStatus.PENDING,
        progress: 0,
        currentStep: null,
        currentStepStartedAt: null,
        error: null,
        totalItems: 0,
        completedItems: 0,
        failedItems: 0,
      };
    }

    // Count status buckets
    const completed = items.filter((i) => i.status === ProcessingStatus.COMPLETED).length;
    const failed = items.filter((i) => i.status === ProcessingStatus.FAILED).length;
    const cancelled = items.filter((i) => i.status === ProcessingStatus.CANCELLED).length;

    // Determine aggregate status
    let status: RequestStatus;
    if (completed === items.length) {
      status = RequestStatus.COMPLETED;
    } else if (failed === items.length) {
      status = RequestStatus.FAILED;
    } else if (failed + cancelled === items.length) {
      status = RequestStatus.FAILED;
    } else {
      // Derive from processing states
      const hasSearching = items.some(
        (i) => i.status === ProcessingStatus.SEARCHING || i.status === ProcessingStatus.PENDING
      );
      const hasDownloading = items.some(
        (i) => i.status === ProcessingStatus.DOWNLOADING || i.status === ProcessingStatus.FOUND
      );
      const hasEncoding = items.some(
        (i) => i.status === ProcessingStatus.ENCODING || i.status === ProcessingStatus.DOWNLOADED
      );
      const hasDelivering = items.some(
        (i) => i.status === ProcessingStatus.DELIVERING || i.status === ProcessingStatus.ENCODED
      );

      if (hasSearching) status = RequestStatus.SEARCHING;
      else if (hasDownloading) status = RequestStatus.DOWNLOADING;
      else if (hasEncoding) status = RequestStatus.ENCODING;
      else if (hasDelivering) status = RequestStatus.DELIVERING;
      else status = RequestStatus.PENDING;
    }

    // Compute average progress
    const totalProgress = items.reduce((sum, item) => sum + item.progress, 0);
    const avgProgress = Math.round(totalProgress / items.length);

    // Find most common current step
    const stepCounts = new Map<string, number>();
    let maxCount = 0;
    let mostCommonStep: string | null = null;

    for (const item of items) {
      if (item.currentStep) {
        const count = (stepCounts.get(item.currentStep) || 0) + 1;
        stepCounts.set(item.currentStep, count);
        if (count > maxCount) {
          maxCount = count;
          mostCommonStep = item.currentStep;
        }
      }
    }

    // Find earliest currentStepStartedAt (use updatedAt as proxy)
    const earliestUpdate = items.reduce((earliest, item) => {
      return !earliest || item.updatedAt < earliest ? item.updatedAt : earliest;
    }, items[0]?.updatedAt || null);

    // Aggregate errors (first error found)
    const firstError = items.find((i) => i.lastError)?.lastError || null;

    return {
      status,
      progress: avgProgress,
      currentStep: mostCommonStep,
      currentStepStartedAt: earliestUpdate,
      error: firstError,
      totalItems: items.length,
      completedItems: completed,
      failedItems: failed,
    };
  }

  /**
   * Get release metadata from most recent Download
   */
  async getReleaseMetadata(requestId: string): Promise<ReleaseMetadata | null> {
    const download = await prisma.download.findFirst({
      where: { requestId },
      orderBy: { createdAt: "desc" },
      select: {
        size: true,
        indexerName: true,
        seedCount: true,
        peerCount: true,
        resolution: true,
        source: true,
        codec: true,
        qualityScore: true,
        publishDate: true,
        torrentName: true,
        isSeasonPack: true,
        season: true,
      },
    });

    if (!download) return null;

    // For TV shows, get episode count
    let episodeCount: number | null = null;
    if (download.isSeasonPack && download.season !== null) {
      episodeCount = await prisma.processingItem.count({
        where: {
          requestId,
          type: "EPISODE",
          season: download.season,
        },
      });
    }

    return {
      fileSize: download.size ? Number(download.size) : 0,
      indexerName: download.indexerName,
      seeders: download.seedCount,
      leechers: download.peerCount,
      resolution: download.resolution,
      source: download.source,
      codec: download.codec,
      score: download.qualityScore,
      publishDate: download.publishDate,
      name: download.torrentName,
      episodeCount,
    };
  }

  /**
   * Batch compute status for multiple requests (optimized)
   */
  async batchComputeStatus(requestIds: string[]): Promise<Map<string, ComputedRequestStatus>> {
    // Fetch all ProcessingItems for all requests in one query
    const allItems = await prisma.processingItem.findMany({
      where: { requestId: { in: requestIds } },
      select: {
        requestId: true,
        status: true,
        progress: true,
        currentStep: true,
        lastError: true,
        updatedAt: true,
      },
    });

    // Group by requestId
    const itemsByRequest = new Map<string, typeof allItems>();
    for (const item of allItems) {
      if (!itemsByRequest.has(item.requestId)) {
        itemsByRequest.set(item.requestId, []);
      }
      itemsByRequest.get(item.requestId)!.push(item);
    }

    // Compute status for each request
    const results = new Map<string, ComputedRequestStatus>();
    for (const requestId of requestIds) {
      const items = itemsByRequest.get(requestId) || [];

      // Use same logic as computeStatus but with pre-fetched items
      // ... (implement same logic as above but with items array)

      results.set(requestId, computedStatus);
    }

    return results;
  }
}

export const requestStatusComputer = new RequestStatusComputer();
```

---

## Frontend Changes Required

### 1. Type Updates

**File**: `packages/client/src/pages/Requests.tsx`

**Lines 22-30 - Update MediaRequest interface**:

```typescript
// BEFORE
interface MediaRequest {
  id: string;
  title: string;
  year: number;
  type: string;
  status: string;
  progress: number;
  posterPath: string | null;
}

// AFTER
interface MediaRequest {
  id: string;
  title: string;
  year: number;
  type: string;
  posterPath: string | null;
  // Status/progress now come from computed properties via API
  status?: string;
  progress?: number;
  currentStep?: string | null;
  error?: string | null;
  // Processing items for detailed status
  processingItems?: ProcessingItem[];
  // Release metadata from Download
  releaseMetadata?: ReleaseMetadata | null;
}
```

### 2. Request List Component Updates

**File**: `packages/client/src/pages/Requests.tsx`

The frontend will receive computed status from the API, so minimal changes needed. However, for more detailed views:

**Option A: Continue using computed status** (simpler):
- API returns computed status/progress
- Frontend displays as-is
- No changes needed to UI

**Option B: Show per-item detail** (more informative):

```typescript
function RequestCard({ request }: { request: MediaRequest }) {
  // Show aggregate status from API
  const aggregateStatus = request.status;
  const aggregateProgress = request.progress;

  // Optionally show per-item breakdown
  const processingItems = request.processingItems || [];

  return (
    <div>
      <h3>{request.title}</h3>
      <StatusBadge status={aggregateStatus} />
      <ProgressBar progress={aggregateProgress} />

      {/* NEW: Show per-item status for TV shows */}
      {request.type === 'tv' && (
        <div className="episode-breakdown">
          <h4>Episodes</h4>
          {processingItems.map(item => (
            <EpisodeStatusItem key={item.id} item={item} />
          ))}
        </div>
      )}

      {/* Release metadata from Download */}
      {request.releaseMetadata && (
        <div className="release-info">
          <span>{request.releaseMetadata.resolution}</span>
          <span>{request.releaseMetadata.source}</span>
          <span>{request.releaseMetadata.codec}</span>
        </div>
      )}
    </div>
  );
}
```

### 3. Episode Status Grid Updates

**File**: `packages/client/src/pages/Requests.tsx` (lines 264-408)

The EpisodeGrid component already fetches data via `getEpisodeStatuses`, which returns ProcessingItems. **No changes needed** - this is already using the right data source.

### 4. Release Metadata Display Updates

**Lines 443-454 - releaseMetadata interface**:

Already correctly typed - just needs to be populated from Download instead of MediaRequest.release* fields. The API changes handle this.

---

## Testing Strategy

### Phase 1: Unit Tests

**New test file**: `packages/server/src/services/__tests__/requestStatusComputer.test.ts`

```typescript
import { requestStatusComputer } from "../requestStatusComputer";
import { prisma } from "../../db/client";

describe("RequestStatusComputer", () => {
  describe("computeStatus", () => {
    it("should return PENDING for request with no items", async () => {
      const result = await requestStatusComputer.computeStatus("fake-id");
      expect(result.status).toBe("PENDING");
      expect(result.totalItems).toBe(0);
    });

    it("should return COMPLETED when all items are completed", async () => {
      // Create test request with 3 COMPLETED items
      const { requestId } = await createTestRequest({
        items: [
          { status: "COMPLETED", progress: 100 },
          { status: "COMPLETED", progress: 100 },
          { status: "COMPLETED", progress: 100 },
        ],
      });

      const result = await requestStatusComputer.computeStatus(requestId);
      expect(result.status).toBe("COMPLETED");
      expect(result.progress).toBe(100);
      expect(result.completedItems).toBe(3);
    });

    it("should return DOWNLOADING when items are downloading", async () => {
      const { requestId } = await createTestRequest({
        items: [
          { status: "DOWNLOADING", progress: 50 },
          { status: "PENDING", progress: 0 },
        ],
      });

      const result = await requestStatusComputer.computeStatus(requestId);
      expect(result.status).toBe("DOWNLOADING");
      expect(result.progress).toBe(25); // Average of 50 and 0
    });
  });

  describe("getReleaseMetadata", () => {
    it("should return null for request with no downloads", async () => {
      const result = await requestStatusComputer.getReleaseMetadata("fake-id");
      expect(result).toBeNull();
    });

    it("should return metadata from most recent download", async () => {
      const { requestId } = await createTestRequest({
        downloads: [
          {
            torrentName: "Movie.2024.1080p.BluRay.x265",
            indexerName: "TestIndexer",
            resolution: "1080p",
            source: "BluRay",
            codec: "HEVC",
            qualityScore: 85,
            size: BigInt(5000000000),
          },
        ],
      });

      const result = await requestStatusComputer.getReleaseMetadata(requestId);
      expect(result).toMatchObject({
        name: "Movie.2024.1080p.BluRay.x265",
        indexerName: "TestIndexer",
        resolution: "1080p",
        source: "BluRay",
        codec: "HEVC",
        score: 85,
        fileSize: 5000000000,
      });
    });
  });
});
```

### Phase 2: Integration Tests

**File**: `packages/server/src/services/pipeline/__tests__/integration/movie-pipeline.test.ts`

Update existing tests to verify:
1. MediaRequest no longer has status/progress fields after migration
2. Computed status matches expected values
3. Release metadata stored in Download, not MediaRequest
4. ProcessingItem updates trigger correct aggregate status

### Phase 3: E2E Tests

**File**: `packages/client/src/__tests__/e2e/requests.test.ts` (new)

```typescript
test("Request list shows correct computed status", async () => {
  // Create a test request
  const request = await createMovieRequest({ title: "Test Movie" });

  // Navigate to requests page
  await page.goto("/requests");

  // Verify status badge displays (computed from API)
  const statusBadge = await page.locator(`[data-request-id="${request.id}"] .status-badge`);
  expect(await statusBadge.textContent()).toBe("Pending");

  // Simulate pipeline progress by updating ProcessingItem
  await updateProcessingItem(request.items[0].id, {
    status: "DOWNLOADING",
    progress: 50
  });

  // Refresh and verify updated status
  await page.reload();
  expect(await statusBadge.textContent()).toBe("Downloading");

  // Verify progress bar
  const progressBar = await page.locator(`[data-request-id="${request.id}"] .progress-bar`);
  expect(await progressBar.getAttribute("data-progress")).toBe("50");
});
```

### Phase 4: Migration Testing

**Manual test checklist**:
- [ ] Run migration on staging database with real data
- [ ] Verify all Download records have correct release metadata
- [ ] Query API endpoints - confirm computed status matches old status
- [ ] Check frontend displays correctly
- [ ] Test retry functionality
- [ ] Test cancel functionality
- [ ] Test quality alternative acceptance
- [ ] Verify no errors in logs

---

## Robustness Improvements Identified

While refactoring, we should also fix these issues:

### 1. JSONB Data Loss Prevention

**Problem**: Partial JSONB updates can cause data loss - JSON merge semantics are fragile.

**Current Code** (everywhere JSONB is used):
```typescript
// DANGEROUS: Overwrites entire targets array
await prisma.mediaRequest.update({
  where: { id },
  data: {
    targets: [{ serverId: 'new-server' }] // LOST: All other targets!
  }
});

// DANGEROUS: Partial JSON merge is error-prone
const currentTargets = request.targets as any[];
currentTargets.push({ serverId: 'new-server' });
await prisma.mediaRequest.update({
  where: { id },
  data: { targets: currentTargets } // Race condition if concurrent updates!
});
```

**Solution**: Use relation tables with proper ACID transactions.

```typescript
// SAFE: Atomic operation, no data loss
await prisma.requestTarget.create({
  data: {
    requestId: id,
    serverId: 'new-server',
    order: 1,
  }
});

// SAFE: Delete specific target without affecting others
await prisma.requestTarget.delete({
  where: {
    requestId_serverId: { requestId: id, serverId: 'old-server' }
  }
});
```

**Benefits**:
- Type safety - compiler catches errors
- Referential integrity - foreign key constraints
- No partial update bugs - atomic operations
- Queryable - can filter/join on normalized data
- Indexable - better performance

### 2. Race Condition: Concurrent MediaRequest Updates

**Problem**: Multiple pipeline steps update MediaRequest.status/progress concurrently, causing race conditions.

**Current Code** (`SearchStep.ts:154-163`):
```typescript
await prisma.mediaRequest.update({
  where: { id: requestId },
  data: {
    status: RequestStatus.SEARCHING,
    progress: 5,
    currentStep: "Checking...",
    currentStepStartedAt: new Date(),
  },
});
```

**Issue**: For TV shows with multiple episodes, each ProcessingItem worker might update MediaRequest simultaneously, causing:
- Lost updates (last write wins)
- Inconsistent progress calculations
- Status flickering in UI

**Solution**: Remove direct MediaRequest updates. Let ProcessingItemRepository.updateRequestAggregates() be the ONLY writer.

```typescript
// Each step updates its own ProcessingItem
await pipelineOrchestrator.transitionStatus(processingItemId, 'SEARCHING', {
  currentStep: "Checking for existing downloads...",
  progress: 5,
});

// ProcessingItemRepository.updateRequestAggregates() runs atomically in a transaction
// No more race conditions!
```

### 3. Stale Data: Release Metadata Duplication

**Problem**: Release metadata stored in both MediaRequest AND Download, causing stale data.

**Current Code** (`requests.ts:1251-1263`):
```typescript
await prisma.mediaRequest.update({
  where: { id: input.id },
  data: {
    releaseFileSize: BigInt(selectedRelease.size),
    releaseIndexerName: selectedRelease.indexerName,
    // ... etc
  },
});

// Download also has this data via Download.torrentName, size, etc.
```

**Issue**: If Download is updated (e.g., retry with different release), MediaRequest becomes stale.

**Solution**: Single source of truth in Download model.

### 4. Error Recovery: No Rollback on Failed Pipeline Steps

**Problem**: If EncodeStep fails after DownloadStep succeeds, no cleanup of partial state.

**Current Behavior**:
- DownloadStep sets `MediaRequest.torrentHash`
- EncodeStep fails
- User retries
- New Download created, but old torrent hash still in MediaRequest
- System confused about which download to use

**Solution**: Remove `MediaRequest.torrentHash` (already deprecated). Use Download.torrentHash as single source of truth.

### 5. Inconsistent State: completedAt vs ProcessingItem Status

**Problem**: MediaRequest.completedAt set when status=COMPLETED, but if status changes back (e.g., retry), completedAt remains.

**Solution**: Remove MediaRequest.completedAt. Compute from ProcessingItems:
```typescript
const allCompleted = items.every(i => i.status === 'COMPLETED');
const completedAt = allCompleted
  ? items.reduce((latest, i) => i.completedAt > latest ? i.completedAt : latest, items[0].completedAt)
  : null;
```

### 6. Performance: N+1 Queries in Request List

**Problem**: `requests.list` fetches MediaRequest, then separately queries for status.

**Current Code**:
```typescript
const requests = await prisma.mediaRequest.findMany();
for (const r of requests) {
  const status = await computeStatus(r.id); // N+1 query!
}
```

**Solution**: Use `batchComputeStatus`:
```typescript
const requests = await prisma.mediaRequest.findMany();
const requestIds = requests.map(r => r.id);
const statusMap = await requestStatusComputer.batchComputeStatus(requestIds);

return requests.map(r => ({
  ...r,
  ...statusMap.get(r.id),
}));
```

### 7. Data Integrity: Orphaned Release Metadata

**Problem**: If Download is deleted but MediaRequest.release* fields remain, stale metadata.

**Solution**: Remove release fields from MediaRequest. Download cascade deletes handle cleanup.

### 8. Type Safety: JSONB Schema Drift

**Problem**: JSONB columns have no schema enforcement - data can diverge from expected structure.

**Example**:
```typescript
// Code expects this:
type Target = { serverId: string; encodingProfileId?: string };

// But database might have:
{ serverId: 123 } // Wrong type!
{ serverID: "..." } // Typo in field name!
{ serverId: null } // Invalid data!
```

**Solution**: Relation tables enforce schema at database level.

```prisma
model RequestTarget {
  serverId String // NOT NULL enforced
  server   StorageServer @relation(...) // Foreign key enforced
}
```

**Benefits**:
- Database validates data structure
- Migrations update all existing data
- No runtime "undefined is not an object" errors
- TypeScript types match database reality

### 9. Dual Context System (CRITICAL BUG)

**Problem**: PipelineExecution.context and ProcessingItem.stepContext are out of sync.

**Current Behavior**:
- PipelineExecutor stores context in `PipelineExecution.context`
- Worker system stores context in `ProcessingItem.stepContext`
- On resume, PipelineExecutor reads stale/empty `PipelineExecution.context`
- SearchStep fails with "requires requestId in context"

**Root Cause**: Two systems evolved independently with no synchronization.

**Solution**:
1. ProcessingItem.stepContext = source of truth
2. On resume, load context from MediaRequest + ProcessingItem.stepContext
3. Deprecate PipelineExecution.context
4. See "Critical Issue: Dual Context System" section for full solution

**Benefits**:
- Fixes resume failures
- Workers and PipelineExecutor use same context
- Context survives restarts
- Single source of truth

---

## Implementation Phases

### Phase 0: Preparation (2 days)
- [ ] Create feature branch: `refactor/media-request-cleanup`
- [ ] Set up test database with production snapshot
- [ ] **Run data audit queries** (see Pre-Migration section)
- [ ] **Backfill ProcessingItems for legacy requests** (CRITICAL)
- [ ] Verify all requests have ProcessingItems
- [ ] Write comprehensive unit tests for RequestStatusComputer
- [ ] Write backwards compatibility tests
- [ ] Document rollback procedures
- [ ] **Take full database backup** before proceeding

### Phase 1: Expand - Add New Fields (1-2 days)
- [ ] Add new fields to Download model (Prisma schema)
- [ ] Generate migration file
- [ ] Create data migration script
- [ ] Test migration on staging data
- [ ] Deploy migration to staging
- [ ] Verify data integrity

**Validation**:
```sql
-- Verify all Downloads have metadata
SELECT COUNT(*) FROM "Download" WHERE "requestId" IN (
  SELECT id FROM "MediaRequest" WHERE "releaseIndexerName" IS NOT NULL
) AND "indexerName" IS NULL;
-- Should return 0

-- Verify all active requests have ProcessingItems
SELECT COUNT(*) FROM "MediaRequest" mr
WHERE mr.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
  AND NOT EXISTS (
    SELECT 1 FROM "ProcessingItem" pi WHERE pi."requestId" = mr.id
  );
-- MUST return 0 or Phase 2 will break!

-- Verify JSONB migrations completed
SELECT
  (SELECT COUNT(*) FROM "MediaRequest" WHERE targets != '[]'::jsonb) as requests_with_targets,
  (SELECT COUNT(DISTINCT "requestId") FROM "RequestTarget") as migrated_targets,
  (SELECT COUNT(*) FROM "MediaRequest" WHERE "requestedEpisodes" IS NOT NULL) as requests_with_episodes,
  (SELECT COUNT(DISTINCT "requestId") FROM "RequestedEpisode") as migrated_episodes;
-- Numbers should match
```

### Phase 2: Contract - Update Code (5-6 days)
- [ ] Implement RequestStatusComputer service
- [ ] Update requests.ts router to use computed properties
- [ ] Update SearchStep to store selectedRelease in ProcessingItem
- [ ] Update DownloadStep to capture release metadata in Download
- [ ] Remove direct MediaRequest status updates from all pipeline steps
- [ ] Update frontend types (optional - API still returns computed status)
- [ ] **NEW: Fix dual context system** (Phase 2B):
  - [ ] Add loadContext() method to PipelineExecutor
  - [ ] Update resumeTreeExecution to use new loader
  - [ ] Update executeStepTree to save to ProcessingItem.stepContext only
  - [ ] Add tests for resume scenarios with Worker-created pipelines
  - [ ] Verify SearchStep no longer fails on resume
- [ ] Write integration tests
- [ ] Manual QA on staging

**Code Review Checklist**:
- [ ] No direct MediaRequest.update() calls for execution state
- [ ] All status/progress derived from ProcessingItems
- [ ] Release metadata stored in Download
- [ ] Batch operations use batchComputeStatus
- [ ] Error handling for missing ProcessingItems
- [ ] Backwards compatibility maintained

### Phase 3: Deploy Code Changes (1-2 days)
- [ ] Merge to main
- [ ] Deploy to staging
- [ ] Run E2E tests on staging
- [ ] Monitor logs for errors
- [ ] Verify UI displays correctly
- [ ] Test retry/cancel/quality workflows
- [ ] Deploy to production (gradual rollout)
- [ ] Monitor for 24 hours

**Monitoring**:
- Check error rates in logs
- Verify no `null` status/progress values in API responses
- Confirm UI renders correctly
- Test user workflows (create request, monitor progress, retry)
- **Monitor backwards compatibility fallback usage**:
  ```typescript
  // Add logging to detect fallback usage
  if (items.length === 0) {
    logger.warn(`[MIGRATION] Request ${requestId} has no ProcessingItems, using fallback`);
    // ...
  }
  ```
- If fallback triggers > 0 times, investigate before Phase 4

### Phase 4: Cleanup - Remove Old Fields (1 day)

**CRITICAL**: Only proceed if Phase 3 has been stable for at least 1 week and:
- [ ] No backwards compatibility fallbacks triggered
- [ ] All active requests have ProcessingItems
- [ ] Full database backup taken (within 24 hours)
- [ ] Rollback procedure tested on staging
- [ ] Generate migration to drop old MediaRequest columns
- [ ] Test migration on staging
- [ ] Deploy to production
- [ ] Verify Prisma client regenerates correctly
- [ ] Remove ProcessingItemRepository.updateRequestAggregates() (now unused)
- [ ] Remove any remaining dead code
- [ ] Update documentation

**Migration File**:
```sql
-- Drop execution state fields
ALTER TABLE "MediaRequest" DROP COLUMN "status";
ALTER TABLE "MediaRequest" DROP COLUMN "progress";
-- ... (all 25 fields)
```

### Phase 5: Optimization & Documentation (2 days)

#### Performance Optimization

- [ ] Add comprehensive database indexes (see below)
- [ ] Profile API performance with realistic data volumes
- [ ] Optimize batch queries (target: <100ms for 100 requests)
- [ ] Add query result caching if needed (Redis or in-memory)
- [ ] Set up monitoring dashboards

**Comprehensive Index Strategy**:
```sql
-- ============================================================================
-- ProcessingItem indexes (critical for computed status)
-- ============================================================================

-- Speed up status computation (most frequent query)
CREATE INDEX "ProcessingItem_requestId_status_progress_idx"
  ON "ProcessingItem"("requestId", "status", "progress")
  WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED');

-- Speed up retry queries
CREATE INDEX "ProcessingItem_status_nextRetryAt_idx"
  ON "ProcessingItem"("status", "nextRetryAt")
  WHERE "nextRetryAt" IS NOT NULL;

-- Speed up worker queries (find items to process)
CREATE INDEX "ProcessingItem_status_createdAt_idx"
  ON "ProcessingItem"("status", "createdAt")
  WHERE status IN ('PENDING', 'SEARCHING', 'FOUND', 'DOWNLOADED', 'ENCODED');

-- ============================================================================
-- RequestTarget indexes
-- ============================================================================

-- Speed up target lookups by request
CREATE INDEX "RequestTarget_requestId_order_idx"
  ON "RequestTarget"("requestId", "order");

-- Speed up server queries (which requests target this server?)
CREATE INDEX "RequestTarget_serverId_idx"
  ON "RequestTarget"("serverId");

-- ============================================================================
-- RequestedEpisode indexes
-- ============================================================================

-- Speed up episode lookups
CREATE INDEX "RequestedEpisode_requestId_season_episode_idx"
  ON "RequestedEpisode"("requestId", "season", "episode");

-- Speed up season queries
CREATE INDEX "RequestedEpisode_requestId_season_idx"
  ON "RequestedEpisode"("requestId", "season");

-- ============================================================================
-- AlternativeRelease indexes
-- ============================================================================

-- Speed up alternative lookups by rank
CREATE INDEX "AlternativeRelease_requestId_rank_score_idx"
  ON "AlternativeRelease"("requestId", "rank", "score" DESC)
  WHERE "requestId" IS NOT NULL;

CREATE INDEX "AlternativeRelease_processingItemId_rank_score_idx"
  ON "AlternativeRelease"("processingItemId", "rank", "score" DESC)
  WHERE "processingItemId" IS NOT NULL;

-- Speed up quality filtering
CREATE INDEX "AlternativeRelease_resolution_source_codec_idx"
  ON "AlternativeRelease"("resolution", "source", "codec");

-- ============================================================================
-- Download indexes
-- ============================================================================

-- Speed up release metadata lookup (most recent first)
CREATE INDEX "Download_requestId_createdAt_idx"
  ON "Download"("requestId", "createdAt" DESC);

-- Speed up torrent hash lookups
-- (Already has unique index on torrentHash from schema)

-- Speed up status queries
CREATE INDEX "Download_status_updatedAt_idx"
  ON "Download"("status", "updatedAt")
  WHERE status IN ('PENDING', 'DOWNLOADING');

-- ============================================================================
-- Verify all indexes created
-- ============================================================================
SELECT
  schemaname,
  tablename,
  indexname
FROM pg_indexes
WHERE tablename IN ('ProcessingItem', 'RequestTarget', 'RequestedEpisode', 'AlternativeRelease', 'Download')
ORDER BY tablename, indexname;
```

#### Performance Testing

- [ ] Benchmark critical queries before/after:
  ```typescript
  // Test with 1000 requests
  console.time('computeStatus');
  await requestStatusComputer.computeStatus(requestId);
  console.timeEnd('computeStatus'); // Target: <10ms

  console.time('batchComputeStatus');
  await requestStatusComputer.batchComputeStatus(requestIds); // 100 requests
  console.timeEnd('batchComputeStatus'); // Target: <100ms

  console.time('getReleaseMetadata');
  await requestStatusComputer.getReleaseMetadata(requestId);
  console.timeEnd('getReleaseMetadata'); // Target: <5ms
  ```

- [ ] Test with production-scale data:
  - 10,000+ MediaRequest records
  - 50,000+ ProcessingItem records
  - 5,000+ Download records
  - Verify index usage with `EXPLAIN ANALYZE`

- [ ] Load test API endpoints:
  - GET /api/requests (list view) - Target: <200ms
  - GET /api/requests/:id (detail view) - Target: <50ms
  - GET /api/requests/:id/alternatives - Target: <100ms

#### Monitoring Setup

- [ ] Add Prometheus metrics:
  ```typescript
  // Track computed status cache hit rate
  const statusComputeCounter = new Counter({
    name: 'request_status_compute_total',
    help: 'Number of status computations'
  });

  const statusComputeDuration = new Histogram({
    name: 'request_status_compute_duration_ms',
    help: 'Status computation duration in ms'
  });

  // Track backwards compatibility fallback usage
  const backwardsCompatCounter = new Counter({
    name: 'request_status_backwards_compat_total',
    help: 'Number of backwards compatibility fallbacks'
  });
  ```

- [ ] Set up alerts:
  - Alert if backwards compatibility fallback triggers > 0 times/hour (after Phase 3)
  - Alert if status computation > 50ms p99
  - Alert if batch status computation > 200ms p99

#### Documentation Updates

- [ ] Update API documentation:
  - Document new computed status behavior
  - Update response schemas (show computed fields)
  - Add migration guide for API clients

- [ ] Update developer guides:
  - How to add new pipeline steps
  - How ProcessingItem.stepContext works
  - Best practices for context management
  - How to query ProcessingItems effectively

- [ ] Update CLAUDE.md:
  ```markdown
  ## Request Status (Post-Refactoring)

  MediaRequest no longer stores execution state. Status is computed from ProcessingItems:

  - **status**: Derived from ProcessingItem statuses (PENDING if all pending, COMPLETED if all completed, etc.)
  - **progress**: Average of all ProcessingItem progress values
  - **currentStep**: Most common ProcessingItem.currentStep
  - **error**: First ProcessingItem.lastError encountered

  To get request status:
  ```typescript
  const computed = await requestStatusComputer.computeStatus(requestId);
  console.log(computed.status, computed.progress);
  ```

  For batch operations:
  ```typescript
  const statusMap = await requestStatusComputer.batchComputeStatus(requestIds);
  ```
  ```

- [ ] Add troubleshooting guide:
  - What to do if computed status is wrong
  - How to manually fix ProcessingItem state
  - How to identify orphaned records

#### Post-Migration Cleanup

- [ ] Remove backwards compatibility code (after 30 days stable):
  ```typescript
  // Remove fallback logic from RequestStatusComputer
  // Remove logging for backwards compat usage
  // Remove old MediaRequest field references in comments
  ```

- [ ] Archive migration scripts:
  - Move backfill scripts to `/migrations/archive/`
  - Document what each script does
  - Keep for reference but mark as archived

- [ ] Database cleanup:
  ```sql
  -- Run VACUUM ANALYZE after dropping columns (reclaim space)
  VACUUM ANALYZE "MediaRequest";
  VACUUM ANALYZE "ProcessingItem";
  VACUUM ANALYZE "Download";

  -- Update statistics
  ANALYZE;
  ```

---

## Rollback Plan

### If Issues Found in Phase 2 (Code Changes)
1. Revert git commits
2. Redeploy previous version
3. No data migration needed (schema hasn't changed yet)

### If Issues Found in Phase 3 (Deployment)
1. Revert code deployment
2. Database schema still compatible (expanded, not contracted)
3. Fix issues and redeploy

### If Issues Found in Phase 4 (Cleanup)
1. **Critical**: Database columns already dropped
2. Restore from backup OR re-add columns with migration:

```sql
-- Rollback migration
ALTER TABLE "MediaRequest" ADD COLUMN "status" "RequestStatus" DEFAULT 'PENDING';
ALTER TABLE "MediaRequest" ADD COLUMN "progress" DOUBLE PRECISION DEFAULT 0;
-- ... (all fields)

-- Repopulate from ProcessingItems
UPDATE "MediaRequest" mr
SET
  "status" = (/* compute from ProcessingItems */),
  "progress" = (/* average from ProcessingItems */);
```

3. Revert code changes
4. Redeploy

**Prevention**: Test migration thoroughly on staging before production.

---

## Communication & Coordination

### Pre-Migration Communication

**1 week before Phase 0**:
- [ ] Email team: "Upcoming database migration - MediaRequest refactoring"
- [ ] Post in team chat: Migration timeline and expected impact
- [ ] Update status page: Maintenance window scheduled

**Before each phase**:
- [ ] Post in team chat: "Starting Phase X - expected duration Y hours"
- [ ] Update status page if any downtime expected
- [ ] Ensure on-call engineer is available

### Maintenance Windows

**Phase 0** (Backfill):
- Recommended: Off-peak hours (2-4 AM)
- Expected duration: 1-2 hours
- Impact: None (read-only operations)

**Phase 1** (Schema expand):
- Recommended: Off-peak hours
- Expected duration: 30 minutes
- Impact: Brief lock on affected tables during ALTER TABLE

**Phase 2** (Code deployment):
- Recommended: During normal business hours (easier to monitor)
- Expected duration: 30 minutes (rolling deployment)
- Impact: None (backwards compatible)

**Phase 3** (Production deployment):
- Recommended: During normal business hours
- Expected duration: 1 hour (careful monitoring)
- Impact: None (backwards compatible)

**Phase 4** (Cleanup):
- Recommended: Off-peak hours (irreversible change)
- Expected duration: 30 minutes
- Impact: Brief lock on MediaRequest table during DROP COLUMN

### Team Coordination Checklist

- [ ] Backend team: Review plan, approve implementation approach
- [ ] Frontend team: Aware of API changes (none expected, but document computed fields)
- [ ] DevOps: Backup procedures verified, rollback plan tested
- [ ] QA: Test plan created, staging environment ready
- [ ] Product: User-facing impact assessed (should be zero)
- [ ] Support: Aware of changes in case users report issues

---

## Success Criteria

### Code Quality
- [ ] Zero direct MediaRequest.update() for execution state
- [ ] All tests passing (unit, integration, E2E)
- [ ] No TypeScript errors
- [ ] No linting errors
- [ ] Code review approved by 2+ reviewers

### Data Integrity
- [ ] All Download records have release metadata
- [ ] Computed status matches old status for existing requests
- [ ] No orphaned data
- [ ] Database constraints enforced

### Performance
- [ ] API response time <= current baseline
- [ ] No N+1 queries in request list
- [ ] Batch queries scale to 100+ requests

### User Experience
- [ ] UI displays correctly
- [ ] No visual regressions
- [ ] Retry/cancel/quality workflows function correctly
- [ ] Real-time updates work (websocket subscriptions)

### Monitoring
- [ ] Error rate <= baseline
- [ ] No new errors in logs
- [ ] Metrics dashboard shows healthy system

---

## Critical Issue: Dual Context System

### Problem Statement

**You've identified a critical bug**: We have TWO parallel pipeline systems with incompatible context storage:

1. **PipelineExecution-based system** (PipelineExecutor.ts)
   - Stores context in `PipelineExecution.context`
   - Used by tree-based pipeline execution
   - Context initialized from MediaRequest fields

2. **Worker-based system** (DownloadWorker, EncodeWorker, etc.)
   - Stores context in `ProcessingItem.stepContext`
   - Used by background workers
   - Context isolated per ProcessingItem

**The Bug**:
```typescript
// Worker creates PipelineExecution but doesn't populate context
await prisma.pipelineExecution.create({
  data: {
    requestId,
    templateId,
    status: "RUNNING",
    steps: template.steps,
    context: {}, // EMPTY! Worker uses ProcessingItem.stepContext instead
  },
});

// On resume, PipelineExecutor reads empty context
async resumeTreeExecution(executionId: string) {
  const execution = await prisma.pipelineExecution.findUnique({
    where: { id: executionId }
  });

  const currentContext = execution.context as PipelineContext; // EMPTY!
  await this.executeStepTree(executionId, stepsTree, currentContext); // BOOM!
}

// SearchStep fails because requestId is missing
async execute(context: PipelineContext, config: unknown) {
  const { requestId } = context; // undefined!
  if (!requestId) {
    throw new Error("SearchStep requires requestId in context"); // ERROR!
  }
}
```

### Root Cause

The systems evolved separately:
- **PipelineExecutor**: Designed for single-request, single-execution workflow
- **Worker system**: Designed for parallel processing of ProcessingItems
- **No synchronization**: PipelineExecution.context and ProcessingItem.stepContext are never merged

### Solution: Unified Context Model

**Decision**: ProcessingItem.stepContext is the source of truth. PipelineExecution.context is deprecated.

#### New Context Loading Strategy

```typescript
// PipelineExecutor.ts - NEW context loader
private async loadContext(executionId: string): Promise<PipelineContext> {
  const execution = await prisma.pipelineExecution.findUnique({
    where: { id: executionId },
    include: {
      request: {
        include: {
          targets: { include: { server: true } },
          processingItems: { take: 1 }, // Get first item for context
        },
      },
    },
  });

  if (!execution) {
    throw new Error(`Execution ${executionId} not found`);
  }

  const request = execution.request;
  const firstItem = request.processingItems[0];

  // Build context from CURRENT request state (not stale PipelineExecution.context)
  const baseContext: PipelineContext = {
    requestId: request.id,
    mediaType: request.type,
    tmdbId: request.tmdbId,
    title: request.title,
    year: request.year,
    targets: request.targets.map(t => ({
      serverId: t.serverId,
      encodingProfileId: t.encodingProfileId,
    })),
    processingItemId: firstItem?.id || request.id,
  };

  // Merge with ProcessingItem.stepContext (source of truth for step state)
  if (firstItem?.stepContext) {
    const itemContext = firstItem.stepContext as Record<string, unknown>;
    Object.assign(baseContext, itemContext);
  }

  return baseContext;
}

// Use new loader on resume
async resumeTreeExecution(executionId: string) {
  const execution = await prisma.pipelineExecution.findUnique({
    where: { id: executionId },
  });

  if (!execution || execution.status !== "RUNNING") {
    return;
  }

  const stepsTree = execution.steps as unknown as StepTree[];

  // NEW: Load context from ProcessingItem, not PipelineExecution
  const currentContext = await this.loadContext(executionId);

  await this.executeStepTree(executionId, stepsTree, currentContext);
  await this.completeExecution(executionId);
}
```

#### Context Update Strategy

```typescript
// After each step, save context to ProcessingItem.stepContext
private async executeStepTree(
  executionId: string,
  steps: StepTree[],
  currentContext: PipelineContext
): Promise<PipelineContext> {
  // ... execute steps ...

  const updatedContext = { /* step output merged */ };

  // Save context to ProcessingItem (source of truth)
  const processingItemId = currentContext.processingItemId;
  if (processingItemId) {
    await prisma.processingItem.update({
      where: { id: processingItemId },
      data: {
        stepContext: updatedContext as Prisma.InputJsonValue,
      },
    });
  }

  // DEPRECATED: Don't update PipelineExecution.context anymore
  // It becomes read-only, only used for debugging

  return updatedContext;
}
```

#### Migration Plan

**Phase 2B: Fix Dual Context (after Phase 2)**

1. **Add context loader** to PipelineExecutor that reads from ProcessingItem
2. **Update resumeTreeExecution** to use new loader
3. **Update executeStepTree** to save context to ProcessingItem only
4. **Mark PipelineExecution.context as deprecated** (keep for debugging)
5. **Add tests** for resume scenarios

**Phase 4B: Remove PipelineExecution.context (after Phase 4)**

Once confident the new system works:
```sql
-- Make context nullable (migration)
ALTER TABLE "PipelineExecution" ALTER COLUMN "context" DROP NOT NULL;

-- Eventually drop it entirely
ALTER TABLE "PipelineExecution" DROP COLUMN "context";
```

### Benefits

1. **Fixes resume bug**: Context always loaded from current state
2. **Single source of truth**: ProcessingItem.stepContext
3. **Worker compatibility**: Workers already use ProcessingItem.stepContext
4. **No data loss**: Context survives pipeline executor restarts
5. **Simpler code**: One context location, not two

### Updated Implementation Timeline

Add 2 days to Phase 2 for context unification:
- **Phase 2**: 3-4 days → **5-6 days**
- **Phase 2B**: Fix dual context system (included above)
- **Total**: 8-11 days → **10-13 days**

---

## Open Questions

1. **Should we keep MediaRequest.monitoring field?**
   - Currently used for RSS/IRC monitoring
   - Could be replaced by a separate MonitoredMedia table
   - **Decision**: Keep for now, deprecate in future refactoring

2. **Should we add MediaRequest.statusUpdatedAt?**
   - Useful for sorting by "last activity"
   - Could compute from ProcessingItem.updatedAt
   - **Decision**: Compute from ProcessingItems for now, add dedicated field if performance becomes an issue

3. **How to handle concurrent writes to ProcessingItem?**
   - Multiple workers might update same ProcessingItem
   - Use optimistic locking?
   - **Decision**: ProcessingItem updates are idempotent, last-write-wins is acceptable

4. **Should ProcessingItem.stepContext have a defined schema?**
   - Currently free-form JSON
   - Could define TypeScript interface and document expected fields
   - **Decision**: Document common fields (search.selectedRelease, download.sourceFilePath, etc.) in code comments, but keep flexible for future step types

---

## Conclusion

This refactoring significantly simplifies the MediaRequest model, establishing clear boundaries between request configuration and execution state. By moving ~25 fields to ProcessingItem and Download, and normalizing 5 JSONB columns into 3 relation tables, we achieve:

- **Better separation of concerns**: Request intent vs. execution state
- **Reduced duplication**: Single source of truth for each piece of data
- **Improved robustness**: Fewer race conditions, no stale data
- **Type safety**: JSONB replaced with strongly-typed relations
- **Data integrity**: Foreign key constraints prevent orphaned data
- **Easier debugging**: Clear ownership of state, queryable relations
- **Better scalability**: Batch operations possible, indexed queries
- **ACID compliance**: No more partial JSON update bugs

**Estimated effort**: 13-17 days total
- Phase 0: 2 days (prep/backfill)
- Phase 1: 1-2 days (expand schema)
- Phase 2: 5-6 days (code changes)
- Phase 3: 1-2 days (deploy/monitor)
- Phase 4: 1 day (cleanup)
- Phase 5: 2 days (optimization/docs)

**Risk level**: Medium-High (requires careful migration, extensive testing, handles legacy data, fixes critical resume bug)

**Value**: Very High
- Long-term maintainability and code simplification
- Robustness improvements (9 bugs fixed)
- Type safety (eliminates JSONB fragility)
- Fixes production bug (dual context system)
- Preserves all existing data (zero data loss)
- Performance improvements (proper indexing)
- Better developer experience (clear separation of concerns)

---

## Appendix A: Complete Field Mapping

| Old (MediaRequest) | New (Location) | Migration Path |
|-------------------|----------------|----------------|
| status | **COMPUTED** from ProcessingItems | requestStatusComputer.computeStatus() |
| progress | **COMPUTED** from ProcessingItems | Average of ProcessingItem.progress |
| currentStep | **COMPUTED** from ProcessingItems | Most common ProcessingItem.currentStep |
| currentStepStartedAt | **COMPUTED** from ProcessingItems | Earliest ProcessingItem.updatedAt |
| error | **COMPUTED** from ProcessingItems | First ProcessingItem.lastError |
| totalItems | **COMPUTED** from ProcessingItems | processingItems.count() |
| completedItems | **COMPUTED** from ProcessingItems | processingItems.count({ status: COMPLETED }) |
| failedItems | **COMPUTED** from ProcessingItems | processingItems.count({ status: FAILED }) |
| completedAt | **COMPUTED** from ProcessingItems | Latest ProcessingItem.completedAt when all complete |
| selectedRelease | ProcessingItem.stepContext.search.selectedRelease | Copy to stepContext |
| torrentHash | **DEPRECATED** | Already using Download.torrentHash |
| sourceFilePath | **DUPLICATE** | ProcessingItem.sourceFilePath already exists |
| encodedFiles | Job.encoderAssignment.outputPath | Track via relations |
| releaseFileSize | Download.size | Copy to Download |
| releaseIndexerName | Download.indexerName | Copy to Download |
| releaseSeeders | Download.seedCount | Copy to Download |
| releaseLeechers | Download.peerCount | Copy to Download |
| releaseResolution | Download.resolution | Copy to Download |
| releaseSource | Download.source | Copy to Download |
| releaseCodec | Download.codec | Copy to Download |
| releaseScore | Download.qualityScore | Copy to Download |
| releasePublishDate | Download.publishDate | Copy to Download |
| releaseName | Download.torrentName | Already exists |
| requiredResolution | **COMPUTED** from targets | deriveRequiredResolution(targets) |
| availableReleases | **JSONB → RELATION** | AlternativeRelease table |
| qualitySearchedAt | ProcessingItem.updatedAt | Track per-item |
| targets | **JSONB → RELATION** | RequestTarget table |
| requestedEpisodes | **JSONB → RELATION** | RequestedEpisode table |

---

## Appendix B: API Response Examples

### Before (current):
```json
{
  "id": "req_123",
  "title": "The Matrix",
  "year": 1999,
  "type": "movie",
  "status": "downloading",
  "progress": 45,
  "currentStep": "Downloading torrent...",
  "error": null,
  "releaseFileSize": 5000000000,
  "releaseIndexerName": "Awesome HD",
  "releaseResolution": "1080p",
  "releaseSource": "BluRay",
  "releaseCodec": "HEVC"
}
```

### After (refactored):
```json
{
  "id": "req_123",
  "title": "The Matrix",
  "year": 1999,
  "type": "movie",
  "posterPath": "/path/to/poster.jpg",
  "targets": [
    { "serverId": "server_1", "serverName": "Main Server" }
  ],
  "requestedSeasons": [],
  "requestedEpisodes": null,
  "createdAt": "2026-01-02T10:00:00Z",
  "updatedAt": "2026-01-02T10:30:00Z",

  // COMPUTED from ProcessingItems:
  "status": "downloading",
  "progress": 45,
  "currentStep": "Downloading torrent...",
  "currentStepStartedAt": "2026-01-02T10:25:00Z",
  "error": null,
  "totalItems": 1,
  "completedItems": 0,
  "failedItems": 0,

  // From Download model:
  "releaseMetadata": {
    "fileSize": 5000000000,
    "indexerName": "Awesome HD",
    "seeders": 42,
    "leechers": 5,
    "resolution": "1080p",
    "source": "BluRay",
    "codec": "HEVC",
    "score": 95,
    "publishDate": "2026-01-01T00:00:00Z",
    "name": "The.Matrix.1999.1080p.BluRay.x265-GROUP"
  }
}
```

**Key difference**: Computed fields now clearly separated from stored configuration, with explicit data sources.

---

## Appendix C: Code Patterns to Avoid

### ❌ ANTI-PATTERN: Direct MediaRequest Status Update
```typescript
// DON'T DO THIS
await prisma.mediaRequest.update({
  where: { id: requestId },
  data: {
    status: RequestStatus.DOWNLOADING,
    progress: 50,
    currentStep: "Downloading...",
  },
});
```

### ✅ CORRECT: Update via ProcessingItem
```typescript
// DO THIS INSTEAD
await pipelineOrchestrator.transitionStatus(processingItemId, 'DOWNLOADING', {
  currentStep: "Downloading torrent...",
  progress: 50,
});

// ProcessingItemRepository.updateRequestAggregates() will compute MediaRequest status
```

### ❌ ANTI-PATTERN: Storing Release Metadata in MediaRequest
```typescript
// DON'T DO THIS
await prisma.mediaRequest.update({
  where: { id: requestId },
  data: {
    releaseFileSize: release.size,
    releaseIndexerName: release.indexerName,
    // ...
  },
});
```

### ✅ CORRECT: Store in Download
```typescript
// DO THIS INSTEAD
const download = await prisma.download.create({
  data: {
    requestId,
    torrentHash: release.hash,
    torrentName: release.title,
    indexerName: release.indexerName,
    resolution: release.resolution,
    source: release.source,
    codec: release.codec,
    qualityScore: release.score,
    publishDate: new Date(release.publishDate),
    size: BigInt(release.size),
    // ...
  },
});
```

### ❌ ANTI-PATTERN: N+1 Queries for Status
```typescript
// DON'T DO THIS
const requests = await prisma.mediaRequest.findMany();
for (const r of requests) {
  const status = await requestStatusComputer.computeStatus(r.id); // N+1!
}
```

### ✅ CORRECT: Batch Compute
```typescript
// DO THIS INSTEAD
const requests = await prisma.mediaRequest.findMany();
const requestIds = requests.map(r => r.id);
const statusMap = await requestStatusComputer.batchComputeStatus(requestIds);

return requests.map(r => ({
  ...r,
  ...statusMap.get(r.id),
}));
```

---

**End of Plan**
