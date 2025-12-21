# TV Show Request Pipeline Fix

## Current Broken Behavior

The request pipeline is designed for single-file downloads (movies) and fails for TV shows:

1. **SearchStep** only searches for ONE season (`requestedSeasons[0]`)
2. **DownloadStep** creates ONE download record
3. **No episode-to-download linking** - TvEpisode records aren't linked to downloads
4. **No file mapping** - Episodes in season packs aren't mapped to their files
5. **Encoding expects single file** - Can't handle extracting episodes from packs

## Required Architecture Changes

### 1. SearchStep Changes

**Current:**
```typescript
await indexer.searchTvSeason({
    season: context.requestedSeasons?.[0] || 1,  // WRONG
});
```

**Fixed:**
- Loop through ALL requested seasons
- Search for each season separately
- Aggregate results
- Smart selection: prefer season packs over individual episodes
- Store search results per-season in context

### 2. DownloadStep Changes

**Current:**
- Creates ONE download
- No episode linking

**Fixed:**
- Create download(s) based on what was found:
  - Season pack → 1 download, link all episodes
  - Individual episodes → 1 download per episode
- Link TvEpisode records to their Download via `downloadId` field
- Set `isSeasonPack` flag correctly
- Store season/episode info

### 3. Episode File Mapping

After download completes, map episodes to files:
- For season packs: scan downloaded files
- Match files to episodes using naming patterns (S01E01, S01E02, etc.)
- Set `sourceFilePath` on each TvEpisode record

### 4. Encoding Step Changes

**Current:**
- Expects single `context.download.sourceFilePath`
- Encodes once

**Fixed:**
- Check if request is TV show
- Get all TvEpisode records for request
- Encode each episode separately
- Update episode progress individually
- Handle season pack extraction

### 5. Delivery Step Changes

**Current:**
- Delivers single file

**Fixed:**
- Deliver each encoded episode separately
- Track delivery per-episode
- Update EpisodeLibraryItem records

## Implementation Plan

### Phase 1: Data Model Validation
- [x] Confirm TvEpisode table has:
  - downloadId (to link to Download)
  - sourceFilePath (specific file within download)
  - status, progress fields

### Phase 2: SearchStep Fix
- [ ] Update SearchStep to search ALL requested seasons
- [ ] Aggregate and rank results
- [ ] Return data structure supporting multiple seasons
- [ ] Write tests

### Phase 3: DownloadStep Fix
- [ ] Handle multiple season results
- [ ] Create appropriate Download records
- [ ] Link TvEpisode records to downloads
- [ ] Add file mapping logic
- [ ] Write tests

### Phase 4: EncodeStep Fix
- [ ] Detect TV show requests
- [ ] Process each episode separately
- [ ] Track per-episode progress
- [ ] Write tests

### Phase 5: DeliverStep Fix
- [ ] Deliver episodes individually
- [ ] Update library tracking
- [ ] Write tests

### Phase 6: Integration Testing
- [ ] End-to-end test: single season
- [ ] End-to-end test: multiple seasons
- [ ] End-to-end test: individual episodes
- [ ] End-to-end test: season pack download

## Alternative: Quick Fix (NOT RECOMMENDED)

The "quick fix" would be to only support single-season requests and search for that one season. This is what's partially happening now, but it's still broken because episodes aren't linked to downloads.

## Recommendation

This is a **major architectural fix** that will take significant time to implement properly. The entire TV show flow needs to be redesigned.

**Options:**
1. **Implement full fix** (~8-16 hours of work)
2. **Disable TV show requests** until proper support is implemented
3. **Support single-season only** as interim solution (still requires phases 2-3)
