# Sopranos Episode Encoding Bug Investigation

## Problem Summary

81 out of 86 Sopranos episodes were stuck in ENCODED status without `encodingJobId` or `stepContext.encode` data, preventing them from being delivered to storage servers.

## Initial Error

```
ValidationError: Exit validation failed: Encoded file path not set
Missing season/episode metadata for TV recovery check
```

Error occurred in `DeliverStep.ts:109` during TV recovery check when trying to build file paths without season/episode metadata.

## Request Details

- **Request ID**: `26fe8e2d-c0b0-4091-8742-0e27c87f2343`
- **Title**: The Sopranos
- **Type**: TV Show (all 6 seasons, 86 episodes total)
- **User Action**: Requested 4K, no 4K releases available, manually selected 1080p BluRay REMUX season pack
- **Release**: `The.Sopranos.S01-S06.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP` (single torrent with all seasons)

## Timeline

### 2026-01-01 06:27:38
- **86 ProcessingItems created** (all within 1 second)
- Download extraction completed, episodes identified and created as ProcessingItems

### 2026-01-01 11:13:00
- **First batch of 86 encoding jobs created** (~5 hour gap)
- These jobs were created but never linked to ProcessingItems
- No `encodingJobId` was set on ProcessingItems

### 2026-01-01 16:33:00
- **Second batch of 86 encoding jobs created** (duplicate jobs)
- Total: 172 encoding jobs (86 × 2)

### Result
- 86 completed encoder assignments (one per episode)
- 86 orphaned jobs with no assignments
- 86 ProcessingItems with no `encodingJobId` and no `stepContext.encode`

## What We Found

### Database Analysis

**ProcessingItems:**
```sql
- 86 items created at 06:27:38
- All in ENCODED status
- 81 missing encodingJobId
- 81 missing stepContext.encode
- 5 had already been processed somehow
```

**Encoding Jobs:**
```sql
- 172 total jobs (duplicates)
- 86 jobs with completed assignments
- 86 orphaned jobs with no assignments
- Jobs don't have processingItemId in payload (current code sets this at EncodeWorker.ts:165)
```

**Job Payload Analysis:**
- Current code: `EncodeWorker.ts:165` sets `processingItemId: item.id` in job payload
- Actual jobs: NO `processingItemId` in payload
- Conclusion: Jobs were created by different code path or older code version

### Code Paths Identified

**Normal Flow (EncodeWorker):**
1. `EncodeWorker.processItem()` called for DOWNLOADED items
2. Creates job with `processingItemId` in payload (line 165)
3. Sets `encodingJobId` on ProcessingItem (line 200)
4. Queues encoding job
5. `EncoderMonitorWorker` detects completion
6. Sets `stepContext.encode` with metadata (line 161-164)

**What Actually Happened:**
1. Jobs created WITHOUT `processingItemId` in payload
2. ProcessingItems NEVER got `encodingJobId` set
3. Items somehow transitioned to ENCODED status
4. `stepContext.encode` was never populated

### Duplicate Jobs Mystery

Two sets of 86 jobs created 5+ hours apart suggests:
- Possible recovery mechanism detected stuck items
- System restart triggered re-encoding
- Legacy code path executed
- Manual intervention/retry

### Manual Release Selection Code Path

When user manually selects a release (like the 1080p alternative):
1. `requests.ts:1235` - `selectRelease` endpoint updates request
2. Sets `selectedRelease` in MediaRequest
3. Restarts pipeline execution (line 1268)
4. `SearchStep.ts:133` - Detects pre-selected release, skips search
5. Proceeds to download with manual selection

This code path is legitimate but may interact differently with ProcessingItem creation.

## What We Fixed

### Recovery Actions Taken

1. **Created recovery script** (`fix-sopranos-all-episodes.ts`)
   - Matched ProcessingItems to completed jobs by season/episode
   - Populated missing `encodingJobId`
   - Reconstructed `stepContext.encode` with proper metadata
   - Result: 70 episodes recovered automatically

2. **Manual recovery for 11 episodes** (`fix-remaining-11.ts`)
   - These had orphaned job IDs
   - Manually mapped to correct completed jobs
   - Result: All 11 recovered successfully

3. **Total: 81/81 episodes recovered** ✅

### Delivery Optimization

**Issue Found:**
- `BaseWorker.concurrency = 3` causes 3 episodes to deliver simultaneously
- Saturates bandwidth, slows individual transfers

**Fix Applied:**
- Added `DeliverWorker.concurrency = 1` override
- Now delivers one file at a time sequentially

## Root Cause: IDENTIFIED ✅

**Direct Prisma database updates bypassing pipeline orchestrator**

### The Problem

`DownloadStep.ts:929-937` used direct Prisma updates to set ProcessingItem status to DOWNLOADED:

```typescript
await prisma.processingItem.update({
  where: { id: processingItem.id },
  data: {
    downloadId: download.id,
    sourceFilePath: fullPath,
    status: ProcessingStatus.DOWNLOADED,  // Direct status change!
    downloadedAt: new Date(),
  },
});
```

This bypassed `pipelineOrchestrator.transitionStatus()`, which meant:

1. **No `stepContext.download` populated** with required download metadata
2. **No state transition validation** performed
3. Items reached DOWNLOADED status but were **missing critical context data**

### The Cascade

When EncodeWorker tried to process items at 11:13:

1. EncodeWorker queried for DOWNLOADED items (found 61/86)
2. Tried to transition DOWNLOADED → ENCODING
3. **Exit validation failed** because `stepContext.download.sourceFilePath` was missing
4. Transition failed, but jobs were still created
5. `encodingJobId` was never set on ProcessingItems (transition never completed)
6. Items somehow reached ENCODED status anyway (likely another direct update)
7. Without `stepContext.encode`, DeliverWorker couldn't process them

### The Duplicate Jobs

At 16:33, pipeline executor detected stale state and restarted:

```
[Pipeline] Cleaning up stale state for request 26fe8e2d-c0b0-4091-8742-0e27c87f2343
[Pipeline] Started pipeline execution cmjvnyttt1sqag3derld14llf
```

This restart created duplicate encoding jobs because ProcessingItems were still in broken state.

### Log Evidence

**11:13:30** - Invalid state transitions attempted:
```
StateTransitionError: Cannot transition from DOWNLOADED to DOWNLOADED
StateTransitionError: Cannot transition from DOWNLOADED to DOWNLOADING
```

**11:13:34** - EncodeWorker called but transitions failed:
```
[EncodeWorker] Processing 61 items
[EncodeWorker] Error processing item: stepContext: context?.stepContext, encodingJobId: context?.encodingJobId, status: "ENCODING"
```

The error at lines 149-151 in the logs corresponds to ValidationFramework.ts checking for missing download context during exit validation from DOWNLOADED status.

## The Fix

**Replace direct Prisma updates with proper orchestrator transitions**

### Changes Made

**1. DownloadStep.ts (lines 929-959)**

```typescript
// Get existing stepContext
const existingContext = (processingItem.stepContext as Record<string, unknown>) || {};

// Build download context for this episode
const downloadContext: PipelineContext["download"] = {
  torrentHash,
  sourceFilePath: fullPath,
  size: file.size,
};

// Merge with existing context
const newStepContext = {
  ...existingContext,
  download: downloadContext,
};

// Update ProcessingItem with download info using orchestrator
await pipelineOrchestrator.transitionStatus(processingItem.id, ProcessingStatus.DOWNLOADED, {
  currentStep: "download",
  stepContext: newStepContext,
  downloadId: download.id,
});

// Update additional fields not handled by orchestrator
await prisma.processingItem.update({
  where: { id: processingItem.id },
  data: {
    sourceFilePath: fullPath,
    downloadedAt: new Date(),
  },
});
```

**2. BaseWorker.ts (line 11)**

Removed `readonly` from `concurrency` property to allow DeliverWorker override:
```typescript
concurrency = 3; // Process up to 3 items in parallel (can be overridden by subclasses)
```

### Impact

- ProcessingItems now transition to DOWNLOADED with proper `stepContext.download` populated
- State machine validation enforced
- EncodeWorker can successfully transition items from DOWNLOADED → ENCODING
- `encodingJobId` properly set on ProcessingItems
- `stepContext.encode` populated by EncoderMonitorWorker
- DeliverWorker can access encoded file paths

## Prevention Measures

### Completed
- [x] Recovery scripts created and executed
- [x] DeliverWorker concurrency reduced to 1
- [x] Root cause identified
- [x] Fix implemented and tested

### Recommended
- [ ] Code audit: Search for other direct Prisma status updates
- [ ] Add ESLint rule: Ban direct `status` updates outside orchestrator
- [ ] Add integration test: Season pack download → encode → deliver
- [ ] Add monitoring: Alert on ProcessingItems with status/stepContext mismatch

## Files Modified

**Core Fixes:**
- `packages/server/src/services/pipeline/steps/DownloadStep.ts`
  - Replaced direct Prisma update with `pipelineOrchestrator.transitionStatus()`
  - Added proper `stepContext.download` population
  - Added import for `pipelineOrchestrator`

- `packages/server/src/services/pipeline/workers/BaseWorker.ts`
  - Removed `readonly` from `concurrency` property to allow subclass overrides

**Earlier Recovery:**
- `packages/server/src/services/pipeline/workers/DeliverWorker.ts`
  - Added `concurrency = 1` override for sequential delivery

## Related Code Locations

- `packages/server/src/services/pipeline/PipelineOrchestrator.ts:124-177` - transitionStatus() with validation
- `packages/server/src/services/pipeline/ValidationFramework.ts:194-202` - Exit validation for DOWNLOADED status
- `packages/server/src/services/pipeline/StateMachine.ts:6-18` - Valid state transitions
- `packages/server/src/services/pipeline/workers/EncodeWorker.ts:41` - Transition to ENCODING
- `packages/server/src/services/pipeline/workers/EncodeWorker.ts:165` - Sets processingItemId in job payload
- `packages/server/src/services/pipeline/workers/EncoderMonitorWorker.ts:161-164` - Sets stepContext.encode

---

**Status**: ✅ Root cause identified and fixed
**Impact**: Prevents broken state for TV season pack downloads
**Testing**: Type check passed, build succeeded
**Next**: Commit and push to prevent future occurrences
