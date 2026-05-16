# SourceDownload Aggregate — Spec

Refactor proposal to harden TV request flow by making `Download` the canonical aggregate that owns the torrent **and** the file→episode mapping, so episode `ProcessingItem`s become consumers of that map rather than independent state machines that each shadow the download.

## Problem

Today's TV path is fragile because state is duplicated and authority is unclear:

1. **File map is ephemeral.** `DownloadStep.extractEpisodeFiles()` parses S##E## from filenames, writes per-episode `stepContext.download.sourceFilePath` AND `ProcessingItem.sourceFilePath`, then forgets. No row exists to reproduce "which file in this torrent corresponds to which episode" after extract.
2. **Parser is naive.** Single regex `S(\d{1,2})E(\d{1,2})`. No multi-episode files (`S01E01E02`), no daily-air dates, no absolute-numbered anime, no "Part 1 / Part 2", no specials.
3. **Each episode independently polls the same `Download`.** N `ProcessingItem`s for one season pack each walk DOWNLOADING → DOWNLOADED, racing on the same underlying torrent state. Worker concurrency multiplies the work; recovery has to reason about N items where there is really one source job.
4. **Cross-request sharing is invisible.** `createDownloadFromExisting()` reuses a `Download` by torrent hash, attaching PIs from a different request. There's no aggregate-level audit of "this torrent is now serving requests A and B"; each PI carries its own opinion of what title the file is.
5. **No idempotent file→episode replay.** Extract is called once from `DownloadStep`. If it crashes mid-loop, partial PIs are advanced and the rest go nowhere; rerunning has to re-discover everything and re-do duplicate work.
6. **Sample / junk file filtering is hardcoded.** No data trail for files that were rejected and why.
7. **Quality and audit data lives on `MediaRequest` and PI, not on the source.** A torrent that produced episodes is gone after cleanup; we lose the "what release did we use, what was its score, what mapping did we choose" record.

## Goal

`Download` (renamed to **`SourceDownload`** conceptually; keep table name to avoid migration churn) becomes the single source of truth for:
- The torrent / NZB / direct-URL job
- Its files and which episode (or movie) each file is for
- The mapping algorithm version that produced the file map
- Cross-request linkage

`ProcessingItem` becomes a thin "this episode wants delivery to these servers" record whose source-file pointer is **derived from the parent `SourceDownload` and `DownloadFile`**, not stored independently.

## Schema delta

### New: `DownloadFile`

```prisma
model DownloadFile {
  id          String   @id @default(cuid())
  downloadId  String
  download    Download @relation(fields: [downloadId], references: [id], onDelete: Cascade)

  // Filesystem identity
  relativePath String  // path relative to Download.contentPath / savePath
  absolutePath String  // resolved path on server filesystem
  sizeBytes    BigInt
  fileHash     String? // optional content hash, for replay safety

  // Parsed mapping
  kind         DownloadFileKind // VIDEO_MAIN | VIDEO_SAMPLE | SUBTITLE | EXTRA | UNKNOWN
  season       Int?
  episode      Int?
  episodeEnd   Int?    // multi-episode files (S01E01E02 → episode=1, episodeEnd=2)
  airDate      DateTime? // for daily-air shows mapping by date
  absoluteNumber Int?  // for anime

  // Mapping provenance
  parserVersion String  // which parser produced this (for replay / migration)
  confidence    Float   // 0-1
  rejected      Boolean @default(false)
  rejectReason  String? // "sample", "too_small", "ambiguous_match", etc.

  // Link to consumer
  processingItemId String? @unique
  processingItem   ProcessingItem? @relation(fields: [processingItemId], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([downloadId, relativePath])
  @@index([downloadId, kind])
  @@index([processingItemId])
}

enum DownloadFileKind {
  VIDEO_MAIN
  VIDEO_SAMPLE
  SUBTITLE
  EXTRA
  UNKNOWN
}
```

### Changes to `ProcessingItem`

- **Remove:** `sourceFilePath` (it lives on `DownloadFile` now; PI joins via `downloadFile`).
- **Remove duplicated `stepContext.download.sourceFilePath`** — derive at read-time.
- **Add:** `downloadFileId String? @unique` with relation to `DownloadFile` (1:1).
- **Keep:** `downloadId` (denormalized convenience for queries).

### Changes to `Download`

- **Add:** `fileMapStatus DownloadFileMapStatus` — `PENDING | MAPPING | MAPPED | FAILED`.
- **Add:** `mapAttempts Int` — bounded retry for the mapping step.
- **Keep everything else.**

```prisma
enum DownloadFileMapStatus {
  PENDING   // download complete, files not yet enumerated
  MAPPING   // mapping in progress
  MAPPED    // DownloadFile rows reflect current torrent contents
  FAILED    // mapping failed permanently (manual intervention)
}
```

## State machine

`SourceDownload` walks an explicit state independent of any one episode:

```
PENDING → DOWNLOADING → COMPLETED → MAPPING → MAPPED → (PROCESSED → CLEANED)
                              ↓
                           FAILED (any state)
```

`MAPPED` is the new gate. PI workers only advance episodes whose `downloadFileId` is set and parent `Download.fileMapStatus = MAPPED`.

A PI without a `downloadFileId` after mapping completes is a **mapping miss** — surfaced explicitly (not silently dropped like today).

## New service: `services/fileMapping/`

Pulls the regex out of `DownloadStep.extractEpisodeFiles` and gives it a home where it can grow.

```
fileMapping/
├── index.ts              # main entry: mapDownloadFiles(downloadId)
├── parsers/
│   ├── seasonEpisode.ts  # S01E01, 1x01, [Season 1 Episode 1]
│   ├── multiEpisode.ts   # S01E01E02, S01E01-02
│   ├── dailyAir.ts       # 2024.05.15, 2024-05-15
│   ├── absoluteNumber.ts # anime: " - 042 "
│   └── partNumber.ts     # "Part 1", "Part 2"
├── classifiers/
│   ├── sample.ts         # sample, trailer, extra detection
│   ├── subtitle.ts       # .srt, .ass association
│   └── junk.ts           # NFO, screens, etc.
└── matcher.ts            # confidence-scored matching of parsed file → PI
```

`mapDownloadFiles(downloadId)`:
1. Reads torrent file list via download client.
2. Runs each file through parsers, picks best candidate by confidence.
3. Classifies kind.
4. Upserts `DownloadFile` rows (idempotent — keyed `(downloadId, relativePath)`).
5. For each `VIDEO_MAIN` file, matches to the best unmatched PI for the same request whose `(season, episode)` window overlaps.
6. Sets `Download.fileMapStatus = MAPPED`.

Idempotent: rerunning the same download produces the same `DownloadFile` rows. Safe to call from a recovery worker.

## Worker changes

### `DownloadWorker`
- Watches `Download` rows, not PIs. On `COMPLETED`, transitions `fileMapStatus` to `MAPPING` and enqueues a `download:map-files` job.
- PI status is updated as a side effect of mapping, not by polling.

### New `FileMapWorker`
- Consumes `download:map-files` jobs.
- Calls `mapDownloadFiles(downloadId)`.
- On success: advances all PIs with matched `DownloadFile`s to `DOWNLOADED`.
- On miss: PIs without a match transition to `QUALITY_UNAVAILABLE` with a clear reason (`mapping_miss: no file matched season X episode Y`).

### `EncodeWorker`
- Reads source path from `processingItem.downloadFile.absolutePath` (or denormalized lookup).
- No `stepContext.download` reads.

### `DeliverWorker`
- Unchanged; already reads from `stepContext.encode`.

## Cross-request safety

`createDownloadFromExisting` keeps current behavior (PIs from request B attach to Download X originally created for request A), but with two guards:

1. **PI-level title check:** before attaching, verify the PI's normalized title matches the Download's parsed title. Mismatch → log + refuse attach; force a fresh download.
2. **Per-DownloadFile uniqueness:** a `DownloadFile` can only be assigned to one PI (`processingItemId @unique`). If request B's S01E01 PI tries to grab the same file already linked to request A's S01E01 PI, it fails loudly — caller decides whether to merge requests or split the download.

This is the structural fix for the title-confusion class of bugs that the encoder-dispatch patch papered over downstream.

## Migration

Single migration, two phases:

**Migration A (additive, safe):**
- Create `DownloadFile` table.
- Add `downloadFileId`, `fileMapStatus`, `mapAttempts` columns (all nullable).
- Backfill: for every PI with `sourceFilePath`, create a `DownloadFile` row, link.
- Backfill: for every `Download` with PIs in `DOWNLOADED` or later, set `fileMapStatus = MAPPED`.

**Migration B (deprecation, after Phase 1 in prod):**
- Drop `ProcessingItem.sourceFilePath`.
- Drop `stepContext.download.sourceFilePath` writes from code paths.

Two-phase to allow rollback during the period workers are being changed over.

## Rollout phases

1. **Schema + backfill** (Migration A). No worker changes yet. Verify backfill counts match expectations on staging.
2. **`fileMapping/` service + `FileMapWorker`**, behind a feature flag `ANNEX_FILE_MAPPING_V2`. Old `DownloadStep.extractEpisodeFiles` still runs when flag off.
3. **Switch `DownloadStep` to call `mapDownloadFiles()`** when flag on. Run shadow comparison: log when new mapping disagrees with old.
4. **Cut over `EncodeWorker`** to read from `DownloadFile`. Keep old `sourceFilePath` reads as fallback.
5. **Migration B + remove fallbacks.**

## Open questions

- **Multi-episode files in delivery.** When one `DownloadFile` covers `S01E01E02`, do we encode once and deliver to two PIs (both pointing at the same encode output, which is fine *because the file legitimately is two episodes*), or split? Recommend: one PI per logical episode but they share the same `downloadFileId` AND the same `encodingJobId`, with a delivery-time naming variant that produces two destination files via filesystem hard-link or copy. Needs design before implementation.
- **Anime / absolute numbering** requires TMDB episode-order resolution. Out of scope for v1; mark anime requests as `mapping_miss` and require manual mapping until v2.
- **Cross-request torrent sharing UX.** Currently silent. Should the UI show "this download is also serving request B"? Probably yes; minor UI follow-up.

## Non-goals

- Changing the encoder dispatch protocol.
- Replacing the indexer search step (separate concern).
- Pipeline template execution model (already deferred per `media.md`).

## Acceptance criteria

- One season-pack torrent → one `Download` row with N `DownloadFile` rows → N `ProcessingItem`s, each linked to exactly one `DownloadFile`.
- Killing the server mid-mapping and restarting produces the same final state (idempotent).
- A torrent with one unparseable filename completes mapping for the rest, marks the unparseable file `kind=UNKNOWN`, and surfaces the affected PI as `mapping_miss` instead of silently stalling.
- Two requests pointing at the same torrent either share files cleanly (PI title matches) or fail loudly (PI title doesn't) — never silently cross-deliver.
