# Phase 2: MediaRequest Refactoring - COMPLETE ✅

**Completion Date**: 2026-01-02
**Branch**: `refactor/media-request-cleanup`
**Status**: Ready for Phase 3 (Deployment)

---

## Summary

Phase 2 successfully refactors MediaRequest execution state tracking to use ProcessingItems as the single source of truth. All direct MediaRequest status updates have been eliminated, and status/progress are now computed on-demand from ProcessingItems.

**Impact**:
- Zero breaking changes to API responses (backwards compatible)
- All 333 server tests passing
- Ready for staging deployment

---

## Completed Tasks

### Core Implementation ✅

1. **RequestStatusComputer Service**
   - Computes status/progress/error from ProcessingItems
   - Efficient batch operations for list views
   - Backwards compatible fallback for legacy requests
   - Location: `src/services/requestStatusComputer.ts`

2. **API Router Updates**
   - `requests.ts` uses `computeStatus()` and `batchComputeStatus()`
   - Release metadata retrieved via `getReleaseMetadata()`
   - Zero changes to API response structure

3. **Pipeline Step Updates**
   - SearchStep stores selectedRelease in ProcessingItem.stepContext
   - DownloadWorker populates Download model metadata fields:
     - indexerName, resolution, source, codec
     - qualityScore, publishDate, seedCount, peerCount
   - All steps removed direct MediaRequest.update() calls

4. **Dual Context System Fix (Phase 2B)**
   - `loadContext()` reconstructs context from ProcessingItem.stepContext
   - `resumeTreeExecution()` uses loadContext() instead of PipelineExecution.context
   - `executeStepTree()` saves context to ProcessingItem.stepContext
   - Backwards compatibility maintained for legacy pipelines

### Test Infrastructure ✅

1. **Mock Prisma Enhancements**
   - Added job and encoderAssignment mocks
   - Added processingItem.create/createMany
   - Added download.findFirst with select support
   - Enhanced findMany to support `{ in: [...] }` syntax

2. **Test Conversions**
   - Converted RequestStatusComputer tests to use mock prisma
   - Fixed integration test expectations for computed status
   - All Cardigann test isolation issues resolved

3. **Test Results**
   - 333 tests passing, 0 failing
   - 5 skipped (intentional)
   - 847 expect() calls

### Code Quality ✅

- **Lint**: ✅ All files pass Biome checks
- **Typecheck**: ✅ Zero TypeScript errors
- **Build**: ✅ All packages build successfully
- **Validation**: All pre-commit checks passing

---

## Key Changes

### Files Modified

**Core Services**:
- `src/services/requestStatusComputer.ts` (new)
- `src/services/pipeline/workers/DownloadWorker.ts`
- `src/services/pipeline/PipelineExecutor.ts`
- `src/routers/requests.ts`

**Test Infrastructure**:
- `src/__tests__/setup.ts`
- `src/__tests__/services/requestStatusComputer.test.ts`
- `src/services/pipeline/__tests__/integration/movie-pipeline.test.ts`

**Recovery Services** (removed status updates):
- `src/services/downloadExtractionRecovery.ts`
- `src/services/encodingRecovery.ts`
- `src/workers/EncoderMonitorWorker.ts`

### Commits

```
d8ddc1e feat(download): populate release metadata when creating Download records
c86c3a1 test(server): fix RequestStatusComputer test isolation issues
68ca6ff test(pipeline): update integration tests for Phase 2 refactoring
64c9d19 test(server): add job and encoderAssignment mocks to test setup
20c87ce feat(requestStatusComputer): implement episodeCount calculation
796b596 refactor(workers): use RequestStatusComputer for status reads
226f168 refactor(recovery): remove MediaRequest execution state updates
af494b8 refactor(pipeline): convert updateRequestAggregates to no-op
bebc2e6 refactor(irc): remove MediaRequest execution state updates
ea319a0 refactor(rss): remove MediaRequest execution state updates
96886dd refactor(delivery): remove MediaRequest execution state updates
```

---

## Backwards Compatibility

### Fallback Mechanisms

1. **computeStatus()**: Falls back to MediaRequest fields when no ProcessingItems exist
2. **getReleaseMetadata()**: Falls back to MediaRequest.release* fields when Download has no metadata
3. **loadContext()**: Falls back to PipelineExecution.context for legacy pipelines

### Migration Safety

- All old MediaRequest fields still exist in schema (not dropped)
- API responses unchanged (clients don't need updates)
- Legacy requests continue to work during transition
- No data loss or breaking changes

---

## Performance

### Query Efficiency

- `computeStatus()`: Single query to fetch ProcessingItems
- `batchComputeStatus()`: Optimized batch query for list views
- `getReleaseMetadata()`: Single query with fallback

### Existing Indexes

ProcessingItem already has indexes on:
- `requestId` - Fast status computation
- `status` - Worker queries
- `status, nextRetryAt` - Retry logic
- `requestId, status` - Combined lookups

---

## Next Steps: Phase 3 (Deployment)

### Prerequisites

✅ All Phase 2 tasks complete
✅ Tests passing (333/333)
✅ Validation passing (lint, typecheck, build)
✅ Branch pushed to GitHub

### Phase 3 Checklist

- [ ] Create pull request from `refactor/media-request-cleanup`
- [ ] Code review and approval
- [ ] Merge to main
- [ ] Deploy to staging environment
- [ ] Run E2E tests on staging
- [ ] Monitor logs for errors:
  - Check for backwards compatibility fallback usage
  - Verify no null status/progress values
  - Confirm UI displays correctly
- [ ] Test user workflows:
  - Create new request
  - Monitor progress
  - Retry failed request
  - Check quality alternatives
- [ ] Deploy to production (gradual rollout)
- [ ] Monitor for 24-48 hours

### Monitoring Points

```typescript
// Watch for backwards compatibility fallbacks
[MIGRATION] Request ${requestId} has no ProcessingItems, using fallback
[MIGRATION] Falling back to PipelineExecution.context for execution ${executionId}
[MIGRATION] Falling back to MediaRequest fields for release metadata
```

If fallback logs appear > 0 times:
1. Investigate why ProcessingItems are missing
2. Verify Worker pipeline execution creates ProcessingItems
3. Check migration completeness

---

## Phase 4 Requirements

**CRITICAL**: Only proceed to Phase 4 after:

1. Phase 3 deployed and stable for **at least 1 week**
2. Zero backwards compatibility fallbacks triggered in logs
3. All active requests have ProcessingItems
4. Full database backup taken (within 24 hours)
5. Rollback procedure tested on staging

Phase 4 will drop old MediaRequest columns (status, progress, error, etc.). This is irreversible without backup.

---

## Documentation

- Phase 2 implementation plan: `pipeline-cleanup.md`
- RequestStatusComputer usage: See inline JSDoc in `requestStatusComputer.ts`
- Testing patterns: See `requestStatusComputer.test.ts`

---

## Team Notes

### For Frontend Developers

- **No changes required** - API responses unchanged
- Optional: Add TypeScript types for computed status (future)

### For Backend Developers

- Use `requestStatusComputer.computeStatus()` to read request status
- Never write to MediaRequest.status/progress/error directly
- All execution state lives in ProcessingItems now
- See `requestStatusComputer.ts` for API

### For DevOps

- Watch backwards compatibility logs during Phase 3
- Database migration will come in Phase 4 (drop old columns)
- No infrastructure changes needed for Phase 2

---

## Success Criteria Met ✅

- [x] No direct MediaRequest.update() calls for execution state
- [x] All status/progress derived from ProcessingItems
- [x] Release metadata stored in Download model
- [x] Batch operations use batchComputeStatus
- [x] Error handling for missing ProcessingItems
- [x] Backwards compatibility maintained
- [x] All tests passing (333/333)
- [x] Code quality checks passing (lint, typecheck, build)
- [x] Dual context system fixed
- [x] Changes pushed to GitHub

---

**Phase 2: COMPLETE** ✅
**Ready for Phase 3: Deployment** 🚀
