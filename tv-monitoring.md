# TV Show Monitoring System (Sonarr-like)

## Overview

A comprehensive TV show monitoring and automation system that tracks shows, monitors air dates, automatically searches for new episodes when they air, and manages the complete lifecycle from airing to delivery.

## Core Concepts

### TV Shows vs Movies

**Movies:**
- One-time acquisition
- Single file
- Request → Download → Encode → Deliver → Complete

**TV Shows:**
- Ongoing series with multiple episodes/seasons
- Weekly/seasonal release schedule
- Subscribe → Monitor → Auto-search on air → Download → Encode → Deliver → Continue monitoring

### Key Differences from Current System

| Current System | TV Monitoring System |
|----------------|---------------------|
| MediaRequest (one-time) | TvShowSubscription (persistent) |
| Manual request per item | Automatic monitoring |
| No air date tracking | Air date driven automation |
| Request completes and closes | Subscription remains active |
| No episode state management | Comprehensive episode states |

## Database Schema

### New Models

#### TvShowSubscription
```prisma
model TvShowSubscription {
  id                String            @id @default(cuid())
  tmdbId            Int               @unique
  title             String
  year              Int?
  posterPath        String?

  // Monitoring configuration
  monitored         Boolean           @default(true)  // Is monitoring active?
  monitorNewSeasons Boolean           @default(true)  // Auto-monitor future seasons?

  // Quality settings
  qualityProfile    String            @default("4K")  // Preferred quality
  upgradeAllowed    Boolean           @default(true)  // Upgrade to better quality?

  // Season/episode selection
  monitoringType    MonitoringType    @default(ALL)
  seasonFilters     Json?             // Which seasons to monitor

  // Delivery targets
  targets           Json              // Array of storage servers

  // Metadata cache
  imdbId            String?
  numberOfSeasons   Int?
  status            String?           // Continuing, Ended, etc.
  network           String?
  airTime           String?           // "9:00 PM"
  airDay            String?           // "Sunday"

  // Tracking
  lastMonitorCheck  DateTime?
  nextEpisodeAirDate DateTime?
  addedAt           DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  // Relations
  seasons           TvSeason[]
  episodes          MonitoredEpisode[]

  @@index([monitored, nextEpisodeAirDate])
}

enum MonitoringType {
  ALL               // Monitor all episodes
  FUTURE            // Only future episodes
  MISSING           // Only missing episodes
  FIRST_SEASON      // Only first season
  LATEST_SEASON     // Only latest season
  NONE              // Don't monitor (manual only)
}
```

#### TvSeason
```prisma
model TvSeason {
  id                String            @id @default(cuid())
  subscriptionId    String
  subscription      TvShowSubscription @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)

  seasonNumber      Int
  name              String?           // "Season 1"
  overview          String?
  posterPath        String?

  // Monitoring
  monitored         Boolean           @default(true)

  // Metadata
  episodeCount      Int?
  airDate           String?           // First episode air date

  // Statistics
  totalEpisodes     Int               @default(0)
  monitoredEpisodes Int               @default(0)
  downloadedEpisodes Int              @default(0)
  missingEpisodes   Int               @default(0)

  episodes          MonitoredEpisode[]

  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  @@unique([subscriptionId, seasonNumber])
  @@index([subscriptionId, monitored])
}
```

#### MonitoredEpisode
```prisma
model MonitoredEpisode {
  id                String              @id @default(cuid())
  subscriptionId    String
  subscription      TvShowSubscription  @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)
  seasonId          String
  season            TvSeason            @relation(fields: [seasonId], references: [id], onDelete: Cascade)

  // Episode identity
  seasonNumber      Int
  episodeNumber     Int
  title             String?
  overview          String?
  stillPath         String?             // Episode thumbnail

  // Air information
  airDate           DateTime?
  airDateUtc        DateTime?
  runtime           Int?                // Minutes

  // Monitoring
  monitored         Boolean             @default(true)

  // Status tracking
  status            EpisodeStatus       @default(UNAIRED)
  hasFile           Boolean             @default(false)
  qualityMet        Boolean             @default(false)

  // Download tracking
  downloadId        String?
  download          Download?           @relation(fields: [downloadId], references: [id], onDelete: SetNull)
  sourceFilePath    String?

  // Quality info
  currentQuality    String?             // "2160p WEB-DL"
  wantedQuality     String?             // From subscription profile

  // Search tracking
  lastSearchDate    DateTime?
  searchAttempts    Int                 @default(0)
  nextSearchDate    DateTime?           // When to retry search

  // Processing
  downloadedAt      DateTime?
  encodedAt         DateTime?
  deliveredAt       DateTime?

  // Library tracking
  inLibrary         Boolean             @default(false)
  libraryItems      EpisodeLibraryItem[]

  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt

  @@unique([subscriptionId, seasonNumber, episodeNumber])
  @@index([status, monitored, airDate])
  @@index([subscriptionId, status])
  @@index([airDate, monitored])
}

enum EpisodeStatus {
  UNAIRED           // Episode hasn't aired yet
  MISSING           // Aired but not downloaded
  WANTED            // Monitored and searching
  SEARCHING         // Active search in progress
  DOWNLOADING       // Download in progress
  DOWNLOADED        // File available, awaiting encode
  ENCODING          // Encoding in progress
  ENCODED           // Encoded, awaiting delivery
  DELIVERING        // Delivery in progress
  COMPLETED         // In library, done
  IGNORED           // Not monitored
  FAILED            // Download/encode failed
  QUALITY_UPGRADE   // In library but upgrading to better quality
}
```

#### MonitoringActivity
```prisma
model MonitoringActivity {
  id                String            @id @default(cuid())
  subscriptionId    String
  episodeId         String?

  type              MonitorActivityType
  message           String
  details           Json?

  createdAt         DateTime          @default(now())

  @@index([subscriptionId, createdAt])
  @@index([type, createdAt])
}

enum MonitorActivityType {
  SUBSCRIPTION_ADDED
  SUBSCRIPTION_UPDATED
  SUBSCRIPTION_REMOVED
  SEASON_MONITORED
  SEASON_UNMONITORED
  EPISODE_AIRED
  EPISODE_SEARCHED
  EPISODE_FOUND
  EPISODE_DOWNLOADED
  EPISODE_UPGRADED
  QUALITY_NOT_MET
  SEARCH_FAILED
}
```

## Core Services

### 1. TvShowMonitoringService

**Responsibilities:**
- Add/remove TV show subscriptions
- Update monitoring settings
- Fetch episode metadata from Trakt
- Sync air dates
- Manage season/episode monitoring flags

**Key Methods:**
```typescript
class TvShowMonitoringService {
  // Subscription management
  async addShow(tmdbId: number, config: SubscriptionConfig): Promise<TvShowSubscription>
  async removeShow(subscriptionId: string): Promise<void>
  async updateMonitoring(subscriptionId: string, settings: MonitoringSettings): Promise<void>

  // Metadata sync
  async syncShowMetadata(subscriptionId: string): Promise<void>
  async refreshEpisodeList(subscriptionId: string): Promise<void>
  async checkForNewSeasons(subscriptionId: string): Promise<void>

  // Season/episode management
  async monitorSeason(seasonId: string, monitored: boolean): Promise<void>
  async monitorEpisode(episodeId: string, monitored: boolean): Promise<void>
  async toggleMonitoring(subscriptionId: string, type: MonitoringType): Promise<void>

  // Statistics
  async getSubscriptionStats(subscriptionId: string): Promise<SubscriptionStats>
  async getCalendar(startDate: Date, endDate: Date): Promise<CalendarEpisode[]>
}
```

### 2. EpisodeMonitoringJob

**Background job that runs periodically (every 15 minutes)**

**Responsibilities:**
- Check for newly aired episodes
- Update episode statuses (UNAIRED → MISSING)
- Trigger searches for aired episodes
- Handle retry logic for failed searches
- Check for quality upgrades

**Algorithm:**
```typescript
async function monitorEpisodes() {
  // 1. Find episodes that just aired
  const newlyAired = await findEpisodesAiredSince(lastCheck);

  for (const episode of newlyAired) {
    if (!episode.monitored) continue;

    // Update status
    await updateEpisodeStatus(episode.id, EpisodeStatus.MISSING);

    // Schedule search (with delay after air time)
    const searchTime = episode.airDateUtc + SEARCH_DELAY;
    await scheduleEpisodeSearch(episode.id, searchTime);

    // Log activity
    await logActivity(episode.subscriptionId, MonitorActivityType.EPISODE_AIRED, {
      episode: `S${episode.seasonNumber}E${episode.episodeNumber}`,
      title: episode.title,
      airDate: episode.airDate,
    });
  }

  // 2. Find episodes ready for search
  const readyForSearch = await findEpisodesReadyForSearch();

  for (const episode of readyForSearch) {
    await searchForEpisode(episode);
  }

  // 3. Check for quality upgrades
  const upgradeEligible = await findEpisodesForUpgrade();

  for (const episode of upgradeEligible) {
    await searchForBetterQuality(episode);
  }

  // 4. Sync metadata for active shows
  const activeShows = await getActiveSubscriptions();
  for (const show of activeShows) {
    if (shouldRefreshMetadata(show)) {
      await refreshEpisodeList(show.id);
    }
  }
}
```

### 3. EpisodeSearchService

**Responsibilities:**
- Search indexers for specific episodes
- Handle season pack vs individual episode preference
- Quality filtering based on subscription profile
- Automatic download initiation

**Key Methods:**
```typescript
class EpisodeSearchService {
  // Search for specific episode
  async searchEpisode(episodeId: string): Promise<SearchResult>

  // Search for entire season
  async searchSeason(subscriptionId: string, seasonNumber: number): Promise<SearchResult>

  // Automatic search triggered by monitoring
  async automaticSearch(episodeId: string): Promise<void>

  // Manual search initiated by user
  async manualSearch(episodeId: string): Promise<Release[]>

  // Quality upgrade search
  async searchForUpgrade(episodeId: string): Promise<Release | null>
}
```

**Search Logic:**
```typescript
async function searchEpisode(episode: MonitoredEpisode) {
  const subscription = await getSubscription(episode.subscriptionId);

  // 1. Search for season pack first (more efficient)
  const seasonPackResults = await indexer.searchTvSeason({
    tmdbId: subscription.tmdbId,
    title: subscription.title,
    year: subscription.year,
    season: episode.seasonNumber,
  });

  // Check if season pack contains this episode
  const suitableSeasonPack = findSeasonPackContainingEpisode(
    seasonPackResults,
    episode.episodeNumber,
    subscription.qualityProfile
  );

  if (suitableSeasonPack) {
    // Download entire season pack
    // Will benefit other episodes in same season
    return await downloadSeasonPack(suitableSeasonPack, episode.seasonId);
  }

  // 2. Search for individual episode
  const episodeResults = await indexer.searchTvEpisode({
    tmdbId: subscription.tmdbId,
    title: subscription.title,
    year: subscription.year,
    season: episode.seasonNumber,
    episode: episode.episodeNumber,
  });

  // Filter by quality
  const suitableRelease = findBestRelease(
    episodeResults,
    subscription.qualityProfile
  );

  if (suitableRelease) {
    return await downloadEpisode(suitableRelease, episode.id);
  }

  // 3. No suitable release found
  await updateEpisodeStatus(episode.id, EpisodeStatus.WANTED);
  await scheduleRetrySearch(episode.id);

  return { found: false };
}
```

### 4. EpisodeDownloadManager

**Responsibilities:**
- Handle downloads that contain multiple episodes (season packs)
- Link episodes to their downloads
- Map episode files within season packs
- Track download progress per-episode

**Key Methods:**
```typescript
class EpisodeDownloadManager {
  // Create download and link episodes
  async downloadSeasonPack(release: Release, seasonId: string): Promise<Download>
  async downloadEpisode(release: Release, episodeId: string): Promise<Download>

  // File mapping
  async mapEpisodeFiles(downloadId: string): Promise<void>
  async identifyEpisodeFile(downloadId: string, episodeId: string): Promise<string | null>

  // Progress tracking
  async updateEpisodeProgress(episodeId: string, progress: number): Promise<void>
}
```

**Season Pack Handling:**
```typescript
async function downloadSeasonPack(release: Release, seasonId: string) {
  // 1. Create download
  const download = await createDownload({
    release,
    isSeasonPack: true,
    season: seasonNumber,
  });

  // 2. Get all monitored episodes for this season
  const episodes = await getMonitoredEpisodesForSeason(seasonId);

  // 3. Link all episodes to this download
  await linkEpisodesToDownload(episodes, download.id);

  // 4. Update episode statuses
  for (const episode of episodes) {
    await updateEpisodeStatus(episode.id, EpisodeStatus.DOWNLOADING);
  }

  // 5. When download completes, map files
  onDownloadComplete(download.id, async () => {
    await mapEpisodeFilesInPack(download.id, seasonId);
  });

  return download;
}

async function mapEpisodeFilesInPack(downloadId: string, seasonId: string) {
  const download = await getDownload(downloadId);
  const files = await listFilesInDownload(download);
  const episodes = await getEpisodesForDownload(downloadId);

  for (const episode of episodes) {
    // Match file to episode using naming patterns
    const pattern = new RegExp(
      `S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber.toString().padStart(2, '0')}`,
      'i'
    );

    const matchingFile = files.find(f => pattern.test(f.name));

    if (matchingFile) {
      await updateEpisode(episode.id, {
        sourceFilePath: matchingFile.path,
        status: EpisodeStatus.DOWNLOADED,
        downloadedAt: new Date(),
        hasFile: true,
      });
    }
  }
}
```

### 5. MetadataSyncService

**Responsibilities:**
- Sync show/season/episode metadata from Trakt
- Detect new episodes/seasons
- Update air dates
- Cache metadata to reduce API calls

**Key Methods:**
```typescript
class MetadataSyncService {
  async syncShow(subscriptionId: string): Promise<void>
  async syncSeason(seasonId: string): Promise<void>
  async detectNewEpisodes(subscriptionId: string): Promise<MonitoredEpisode[]>
  async updateAirDates(subscriptionId: string): Promise<void>
}
```

## Background Jobs

### Job Schedule

| Job | Frequency | Purpose |
|-----|-----------|---------|
| Episode Monitoring | 15 minutes | Check for aired episodes, trigger searches |
| Metadata Sync | 6 hours | Refresh show/episode metadata |
| New Season Detection | Daily | Check for newly announced seasons |
| Quality Upgrade Check | Daily | Search for better quality versions |
| Calendar Update | Hourly | Update upcoming episodes calendar |

### Job Implementations

#### Episode Monitor Job
```typescript
scheduler.register(
  "episode-monitor",
  "Episode Monitoring",
  15 * 60 * 1000, // 15 minutes
  async () => {
    const monitor = getEpisodeMonitoringJob();
    await monitor.run();
  }
);
```

#### Metadata Sync Job
```typescript
scheduler.register(
  "metadata-sync",
  "Metadata Sync",
  6 * 60 * 60 * 1000, // 6 hours
  async () => {
    const sync = getMetadataSyncService();
    const subscriptions = await getActiveSubscriptions();

    for (const sub of subscriptions) {
      await sync.syncShow(sub.id);
    }
  }
);
```

## tRPC API Endpoints

### Subscriptions
```typescript
subscriptions: {
  // List all subscribed shows
  list: publicProcedure.query(() => { ... }),

  // Get subscription details
  get: publicProcedure.input(z.string()).query(({ input }) => { ... }),

  // Add new show
  add: publicProcedure
    .input(z.object({
      tmdbId: z.number(),
      monitoringType: z.enum(['ALL', 'FUTURE', 'MISSING', 'LATEST_SEASON']),
      qualityProfile: z.string(),
      targets: z.array(targetSchema),
    }))
    .mutation(({ input }) => { ... }),

  // Remove show
  remove: publicProcedure.input(z.string()).mutation(({ input }) => { ... }),

  // Update monitoring settings
  updateMonitoring: publicProcedure
    .input(z.object({
      subscriptionId: z.string(),
      monitored: z.boolean().optional(),
      monitorNewSeasons: z.boolean().optional(),
      monitoringType: z.enum(['ALL', 'FUTURE', 'MISSING', 'LATEST_SEASON']).optional(),
    }))
    .mutation(({ input }) => { ... }),
}
```

### Episodes
```typescript
episodes: {
  // Get episodes for a show
  list: publicProcedure
    .input(z.object({
      subscriptionId: z.string(),
      seasonNumber: z.number().optional(),
    }))
    .query(({ input }) => { ... }),

  // Get episode details
  get: publicProcedure.input(z.string()).query(({ input }) => { ... }),

  // Toggle episode monitoring
  toggleMonitoring: publicProcedure
    .input(z.object({
      episodeId: z.string(),
      monitored: z.boolean(),
    }))
    .mutation(({ input }) => { ... }),

  // Manual search for episode
  search: publicProcedure.input(z.string()).mutation(({ input }) => { ... }),

  // Get calendar
  calendar: publicProcedure
    .input(z.object({
      start: z.date(),
      end: z.date(),
    }))
    .query(({ input }) => { ... }),
}
```

### Seasons
```typescript
seasons: {
  // Get seasons for a show
  list: publicProcedure.input(z.string()).query(({ input }) => { ... }),

  // Toggle season monitoring
  toggleMonitoring: publicProcedure
    .input(z.object({
      seasonId: z.string(),
      monitored: z.boolean(),
    }))
    .mutation(({ input }) => { ... }),
}
```

## UI Components

### Required Pages/Views

#### 1. TV Shows List Page
- Grid/list of all subscribed shows
- Show poster, title, monitoring status
- Statistics: X/Y episodes downloaded
- Next episode air date
- Quick actions: refresh, edit, remove

#### 2. Show Details Page
- Show metadata and poster
- Season list with episode counts
- Monitoring controls per season
- Recent activity
- Search all missing button

#### 3. Season/Episode List
- Episode grid with air dates
- Episode status indicators
- Manual search per episode
- Monitoring toggle per episode
- Download progress

#### 4. Calendar View
- Monthly/weekly calendar
- Episodes airing each day
- Color-coded by status
- Quick access to manual search

#### 5. Activity Feed
- Real-time monitoring activity
- Episode searches, downloads, errors
- Filterable by show/type

## Configuration

### Quality Profiles

Pre-defined quality profiles users can assign to subscriptions:

```typescript
const QualityProfiles = {
  "4K": {
    preferred: "2160p",
    minimum: "2160p",
    allowed: ["2160p WEB-DL", "2160p BluRay"],
    upgradeUntil: "2160p BluRay REMUX",
  },
  "1080p": {
    preferred: "1080p",
    minimum: "1080p",
    allowed: ["1080p WEB-DL", "1080p BluRay"],
    upgradeUntil: "1080p BluRay",
  },
  "Any": {
    preferred: "1080p",
    minimum: "720p",
    allowed: ["720p", "1080p", "2160p"],
    upgradeUntil: null,
  },
};
```

### Monitoring Settings

```typescript
interface MonitoringSettings {
  // When to search after episode airs
  searchDelay: number; // minutes (default: 60)

  // How long to keep searching if not found
  maxSearchDays: number; // days (default: 7)

  // Retry interval for failed searches
  retryInterval: number; // hours (default: 6)

  // Enable quality upgrades
  upgradeEnabled: boolean; // default: true

  // How long to wait for upgrade
  upgradeUntilDays: number; // days (default: 30)
}
```

## Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Create database schema and migrations
- [ ] Implement TvShowMonitoringService
- [ ] Implement MetadataSyncService
- [ ] Basic tRPC endpoints (add/remove/list subscriptions)
- [ ] Write tests for core services

### Phase 2: Monitoring Engine (Week 2)
- [ ] Implement EpisodeMonitoringJob
- [ ] Implement EpisodeSearchService
- [ ] Implement EpisodeDownloadManager
- [ ] Handle season pack downloads
- [ ] Episode file mapping logic
- [ ] Write tests for monitoring and search

### Phase 3: UI - Basic (Week 3)
- [ ] TV Shows list page
- [ ] Add subscription flow
- [ ] Show details page with seasons
- [ ] Episode list with status indicators
- [ ] Manual search functionality

### Phase 4: UI - Advanced (Week 4)
- [ ] Calendar view
- [ ] Activity feed
- [ ] Monitoring controls per season/episode
- [ ] Statistics and dashboards
- [ ] Settings page for monitoring config

### Phase 5: Integration (Week 5)
- [ ] Connect to existing encode pipeline
- [ ] Connect to existing delivery system
- [ ] Library sync integration
- [ ] Handle quality upgrades
- [ ] Notification system integration

### Phase 6: Polish & Testing (Week 6)
- [ ] End-to-end testing
- [ ] Performance optimization
- [ ] Error handling and recovery
- [ ] Documentation
- [ ] Migration path from current system

## Migration Strategy

### Migrating Existing TV Show Requests

```typescript
async function migrateExistingTvRequests() {
  const tvRequests = await prisma.mediaRequest.findMany({
    where: { type: MediaType.TV },
    include: { tvEpisodes: true },
  });

  for (const request of tvRequests) {
    // Create subscription
    const subscription = await addShow(request.tmdbId, {
      monitored: true,
      qualityProfile: request.requiredResolution || "4K",
      targets: request.targets,
    });

    // Sync metadata to get all episodes
    await syncShowMetadata(subscription.id);

    // Mark existing episodes as monitored
    for (const ep of request.tvEpisodes) {
      const monitoredEpisode = await findEpisode(
        subscription.id,
        ep.season,
        ep.episode
      );

      if (monitoredEpisode) {
        await updateEpisode(monitoredEpisode.id, {
          monitored: true,
          status: ep.status === "COMPLETED"
            ? EpisodeStatus.COMPLETED
            : EpisodeStatus.MISSING,
          hasFile: ep.status === "COMPLETED",
          downloadId: ep.downloadId,
          sourceFilePath: ep.sourceFilePath,
        });
      }
    }

    // Archive old request
    await prisma.mediaRequest.update({
      where: { id: request.id },
      data: { status: RequestStatus.MIGRATED },
    });
  }
}
```

## Technical Considerations

### Performance
- Episode metadata cached in database
- Incremental sync (only update changed data)
- Index on air dates for efficient queries
- Batch processing for monitoring checks

### Scalability
- Background jobs use queue system
- Can run multiple workers
- Rate limiting on Trakt API calls
- Efficient queries with proper indexes

### Reliability
- Failed searches automatically retried
- Metadata sync failures don't block system
- Graceful degradation if Trakt is down
- Transaction handling for critical operations

### Air Date Handling
- Store both local and UTC air times
- Handle timezone conversions
- Account for DST changes
- Support TBA (to be announced) episodes

## Comparison to Sonarr

| Feature | Sonarr | Annex TV Monitoring |
|---------|--------|---------------------|
| Show subscriptions | ✅ | ✅ |
| Automatic monitoring | ✅ | ✅ |
| Episode air date tracking | ✅ | ✅ |
| Quality profiles | ✅ | ✅ |
| Season packs | ✅ | ✅ |
| Quality upgrades | ✅ | ✅ |
| Calendar view | ✅ | ✅ |
| RSS feed support | ✅ | ❌ (use indexers) |
| Custom formats | ✅ | ❌ (future) |
| Import existing files | ✅ | ❌ (future) |
| Multiple profiles | ✅ | ✅ |
| Indexer management | ✅ | ✅ (existing) |
| Encoding pipeline | ❌ | ✅ (Annex feature) |
| Multi-server delivery | ❌ | ✅ (Annex feature) |

## Success Criteria

### Functional Requirements
- [ ] User can add TV show and it monitors automatically
- [ ] New episodes detected within 15 minutes of airing
- [ ] Automatic search triggered after configurable delay
- [ ] Season packs preferred over individual episodes
- [ ] Episodes correctly linked to downloads
- [ ] Files properly mapped within season packs
- [ ] Quality upgrades work automatically
- [ ] Calendar shows upcoming episodes
- [ ] Activity feed shows all monitoring events

### Performance Requirements
- [ ] Monitoring job completes in < 60 seconds
- [ ] Can handle 100+ subscribed shows
- [ ] Metadata sync completes in < 5 minutes per show
- [ ] Search initiation happens within 1 minute of trigger
- [ ] UI loads subscription list in < 2 seconds

### Reliability Requirements
- [ ] Failed searches retry automatically
- [ ] System recovers from Trakt API failures
- [ ] No duplicate downloads for same episode
- [ ] Monitoring continues after server restart
- [ ] Episode statuses remain accurate

## Future Enhancements

- Custom quality formats (like Sonarr)
- Import existing episode files
- Multi-language support
- Advanced scheduling (download only during off-peak hours)
- Integration with Plex/Emby watch status
- Automatic deletion after watched
- Subtitle management
- Advanced filtering (ignore specific release groups)
