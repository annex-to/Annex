# Season Pack Processing Issues - Root Cause Analysis & Fixes

## Issues Identified

### 1. **Incomplete Episode Linking to Season Pack Downloads** [CRITICAL]
**Symptom:** Not all episodes in a request get linked to the season pack download
- The Abandons: 3 out of 7 episodes initially had no downloadId
- Chernobyl: 3 out of 5 episodes stuck in FOUND status without downloadId

**Root Cause:** Race condition in parallel episode processing
- Multiple episodes process simultaneously in SearchWorker/DownloadWorker
- When they find an existing season pack, they should all link to the same Download record
- However, the linking logic doesn't properly handle concurrent access
- Some episodes complete before others, leaving stragglers unlinked

**Evidence:**
```
# Chernobyl episodes stuck in FOUND with no downloadId
1:23:45                      | FOUND       | search_complete | NULL
Please Remain Calm           | FOUND       | search_complete | NULL
Open Wide, O Earth           | FOUND       | search_complete | NULL

# While these 2 were properly linked:
The Happiness of All Mankind | DOWNLOADING | download        | cmjxqs6wb00q7g326aa98gzsg
Vichnaya Pamyat              | DOWNLOADING | download        | cmjxqs6wb00q7g326aa98gzsg
```

**Impact:** Episodes get stuck indefinitely, requiring manual SQL updates

---

### 2. **Existing Download Detection Fails for Individual Episodes**
**Symptom:** When SearchStep finds an existing season pack download, individual episodes don't transition properly

**Root Cause:** DownloadWorker's `handleExistingDownload()` doesn't properly handle season packs
- SearchStep correctly finds existing season pack in qBittorrent
- SearchStep returns `existingDownload` in context
- DownloadWorker calls `handleExistingDownload()` but this is designed for individual episode/movie downloads
- For season packs, it needs special logic to link the episode to the existing bulk download

**Evidence from logs:**
```
[Search] Season pack check result: Found: Chernobyl (2019) Season 01 S01...
[DownloadWorker] Processing EPISODE 1:23:45
[QBittorrent] addTorrentFile response: status=200, body="Fails."
[DownloadManager] Failed to add torrent or no hash returned
```

**Impact:** Episodes loop PENDING → SEARCHING → FOUND indefinitely

---

### 3. **Episodes Stuck at DOWNLOADING 100% Don't Auto-Progress**
**Symptom:** Episodes showing 100% download progress remain in DOWNLOADING status

**Root Cause:** Missing transition logic when season pack completes
- DownloadProgressWorker updates progress to 100%
- No worker transitions items from DOWNLOADING to DOWNLOADED when complete
- DownloadRecoveryWorker may not handle season pack completion

**Impact:** Episodes stuck until manually reset to PENDING

---

### 4. **No Automatic State Recovery**
**Symptom:** Various stuck states require manual SQL intervention

**Root Cause:** No cleanup/recovery worker to detect and fix:
- Episodes in FOUND with no downloadId for extended periods
- Episodes at 100% DOWNLOADING that should be DOWNLOADED
- Orphaned episodes not linked to their season pack

**Impact:** System requires constant manual monitoring and fixes

---

### 5. **Inconsistent Season Pack Support**
**Symptom:** Had to add `selectedPacks` checks to multiple files

**Root Cause:** Season pack support added incrementally without comprehensive audit
- Fixed: PipelineContext, SearchWorker, ValidationFramework, DownloadWorker
- But pattern suggests other workers may have similar gaps

**Impact:** Validation failures, unexpected errors in other workers

---

## Proposed Fixes

### Fix 1: Atomic Season Pack Episode Assignment
**Priority:** P0 - Critical
**File:** `src/services/pipeline/workers/DownloadWorker.ts`

**Problem:** Episodes process individually and race to link to season pack

**Solution:** Batch assignment for all episodes in a season when season pack is selected

**Implementation:**
```typescript
// When processing an item with selectedPacks, find ALL episodes for this season
async processSeasonPackRequest(item: ProcessingItem, searchData: PipelineContext["search"]) {
  // Find ALL episodes in this request for the same season
  const allSeasonEpisodes = await prisma.processingItem.findMany({
    where: {
      requestId: item.requestId,
      type: "EPISODE",
      season: item.season,
      status: { in: ["FOUND", "SEARCHING"] }
    }
  });

  // Create or find existing download
  const download = await findOrCreateSeasonPackDownload(searchData.selectedPacks[0]);

  // Atomically link ALL episodes in a single transaction
  await prisma.$transaction(
    allSeasonEpisodes.map(ep =>
      prisma.processingItem.update({
        where: { id: ep.id },
        data: {
          downloadId: download.id,
          status: "DOWNLOADING",
          currentStep: "download"
        }
      })
    )
  );
}
```

---

### Fix 2: Proper Existing Season Pack Detection & Linking
**Priority:** P0 - Critical (fixes Chernobyl stuck episodes)
**File:** `src/services/pipeline/workers/DownloadWorker.ts`

**Problem:** `handleExistingDownload()` doesn't handle season packs for individual episodes

**Solution:** When existing season pack found, link ALL episodes in that season

**Implementation:**
```typescript
async handleExistingDownload(
  item: ProcessingItem,
  request: MediaRequest,
  searchData: PipelineContext["search"]
) {
  const existing = searchData.existingDownload;

  // Find or create Download record
  let download = await prisma.download.findFirst({
    where: { torrentHash: existing.torrentHash }
  });

  if (!download) {
    download = await createDownloadFromExisting(existing, request);
  }

  // For season pack episodes, link ALL episodes in this season atomically
  if (item.type === "EPISODE" && item.season) {
    await this.linkAllSeasonEpisodesToDownload(
      item.requestId,
      item.season,
      download.id
    );
  } else {
    await this.linkItemToDownload(item.id, download.id);
  }
}

async linkAllSeasonEpisodesToDownload(
  requestId: string,
  season: number,
  downloadId: string
) {
  // Find all episodes in this season that need linking
  const episodes = await prisma.processingItem.findMany({
    where: {
      requestId,
      season,
      type: "EPISODE",
      status: { in: ["FOUND", "SEARCHING", "PENDING"] }
    }
  });

  // Atomic batch update
  await prisma.$transaction(
    episodes.map(ep =>
      prisma.processingItem.update({
        where: { id: ep.id },
        data: {
          downloadId,
          status: "DOWNLOADING",
          currentStep: "download"
        }
      })
    )
  );

  console.log(`[${this.name}] Linked ${episodes.length} episodes to download ${downloadId}`);
}
```

---

### Fix 3: Stuck State Recovery Worker
**Priority:** P1 - High
**File:** `src/services/pipeline/workers/StuckItemRecoveryWorker.ts` (new)

**Problem:** No automatic detection and recovery of stuck states

**Solution:** Periodic worker to detect and fix common stuck states

**Implementation:**
```typescript
export class StuckItemRecoveryWorker extends BaseWorker {
  readonly processingStatus = "PENDING" as const;
  readonly name = "StuckItemRecoveryWorker";
  readonly pollInterval = 60000; // 1 minute

  async processBatch(): Promise<void> {
    await this.recoverFoundWithoutDownloadId();
    await this.recoverCompletedDownloads();
    await this.recoverMixedSeasonDownloads();
  }

  /**
   * Fix episodes stuck in FOUND with no downloadId
   */
  async recoverFoundWithoutDownloadId() {
    const stuckItems = await prisma.processingItem.findMany({
      where: {
        status: "FOUND",
        downloadId: null,
        updatedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } // Stuck for >5min
      }
    });

    if (stuckItems.length === 0) return;

    console.log(`[${this.name}] Found ${stuckItems.length} stuck FOUND items, resetting to PENDING`);

    await prisma.processingItem.updateMany({
      where: { id: { in: stuckItems.map(i => i.id) } },
      data: { status: "PENDING", currentStep: null }
    });
  }

  /**
   * Fix downloads stuck at 100% in DOWNLOADING status
   */
  async recoverCompletedDownloads() {
    const completedItems = await prisma.processingItem.findMany({
      where: {
        status: "DOWNLOADING",
        progress: { gte: 100 },
        updatedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) }
      }
    });

    if (completedItems.length === 0) return;

    console.log(`[${this.name}] Found ${completedItems.length} completed downloads stuck in DOWNLOADING`);

    // Reset to PENDING to let them re-process
    await prisma.processingItem.updateMany({
      where: { id: { in: completedItems.map(i => i.id) } },
      data: { status: "PENDING", currentStep: null }
    });
  }

  /**
   * Fix seasons where some episodes have downloadId and others don't
   */
  async recoverMixedSeasonDownloads() {
    const mixedSeasons = await prisma.$queryRaw<Array<{
      requestId: string;
      season: number;
      total: number;
      linked: number;
      download_id: string;
    }>>`
      SELECT "requestId", season,
             COUNT(*) as total,
             COUNT("downloadId") as linked,
             MAX("downloadId") as download_id
      FROM "ProcessingItem"
      WHERE type = 'EPISODE'
        AND season IS NOT NULL
        AND status IN ('FOUND', 'DOWNLOADING', 'SEARCHING')
      GROUP BY "requestId", season
      HAVING COUNT(*) != COUNT("downloadId")
         AND COUNT("downloadId") > 0
    `;

    for (const season of mixedSeasons) {
      console.log(
        `[${this.name}] Fixing mixed season: ${season.linked}/${season.total} episodes linked`
      );

      // Link unlinked episodes to the download that others have
      await prisma.processingItem.updateMany({
        where: {
          requestId: season.requestId,
          season: season.season,
          downloadId: null,
          status: { in: ["FOUND", "SEARCHING"] }
        },
        data: {
          downloadId: season.download_id,
          status: "DOWNLOADING",
          currentStep: "download"
        }
      });
    }
  }
}

export const stuckItemRecoveryWorker = new StuckItemRecoveryWorker();
```

---

### Fix 4: Comprehensive Season Pack Audit
**Priority:** P2 - Medium
**Files:** All workers

**Action Items:**
1. Grep for all `selectedRelease` checks
2. Ensure `selectedPacks` is also checked
3. Add season pack test cases

**Files to audit:**
- ✅ SearchWorker.ts
- ✅ ValidationFramework.ts
- ✅ DownloadWorker.ts
- ⚠️  EncodeWorker.ts
- ⚠️  DeliverWorker.ts
- ⚠️  DownloadProgressWorker.ts
- ⚠️  DownloadRecoveryWorker.ts

---

## Implementation Order

1. **Fix 2** - Existing season pack linking (fixes current Chernobyl issue)
2. **Fix 1** - Atomic episode assignment (prevents future occurrences)
3. **Fix 3** - Recovery worker (automatic cleanup)
4. **Fix 4** - Audit other workers (ensure consistency)

---

## Testing

### Test Case 1: New Season Pack Request
- Create TV show request for full season
- Verify ALL episodes link to same downloadId
- No episodes stuck in FOUND

### Test Case 2: Existing Season Pack
- Start season pack download in qBittorrent
- Create new request for same season
- Verify ALL episodes link to existing download

### Test Case 3: Recovery Worker
- Manually create stuck states (FOUND with no downloadId)
- Wait 5 minutes
- Verify recovery worker fixes them

---

## Success Metrics

- **Zero manual SQL queries** needed to fix stuck episodes
- **100% episode linking rate** for season pack requests  
- **Automatic recovery** within 5 minutes
- **No validation errors** for season packs
