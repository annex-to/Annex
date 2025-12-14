/**
 * Taste Profile Service
 *
 * Builds a user's taste profile from their Plex/Emby watch history.
 * Used to personalize the "For You" discovery mode.
 */

import { prisma } from "../db/client.js";
import { getConfig } from "../config/index.js";
import { fetchPlexWatchedItems, type PlexWatchedItem } from "./plex.js";
import { fetchEmbyWatchedItems, type EmbyWatchedItem } from "./emby.js";
import { getSchedulerService } from "./scheduler.js";

// =============================================================================
// Types
// =============================================================================

export interface WatchedItem {
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  viewCount: number;
  lastViewedAt?: Date;
}

export interface GenreWeight {
  genre: string;
  weight: number; // 0-1 normalized
  count: number;
}

export interface TasteProfile {
  userId: string;
  genres: GenreWeight[];
  totalWatched: number;
  fetchedAt: Date;
}

interface CachedProfile {
  profile: TasteProfile;
  expiresAt: Date;
}

interface PlexAccount {
  plexToken: string | null;
}

interface EmbyAccount {
  embyId: string;
  embyToken: string | null;
  embyServerId: string | null;
}

// =============================================================================
// Service
// =============================================================================

class TasteProfileService {
  private cache: Map<string, CachedProfile> = new Map();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Register cleanup task with the scheduler
   * Called once during server startup
   */
  registerTasks(): void {
    const scheduler = getSchedulerService();
    scheduler.register(
      "taste-cache-cleanup",
      "Taste Cache Cleanup",
      60 * 1000, // 1 minute
      async () => {
        this.cleanupExpiredEntries();
      }
    );
  }

  /**
   * Get or fetch taste profile for a user
   * Returns null if user has no linked media server account or no watch history
   */
  async getTasteProfile(
    userId: string,
    plexAccount: PlexAccount | null,
    embyAccount: EmbyAccount | null
  ): Promise<TasteProfile | null> {
    // Check cache first
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > new Date()) {
      return cached.profile;
    }

    // Fetch watch history from available sources
    const watchedItems: WatchedItem[] = [];

    // Fetch from Plex if available
    if (plexAccount?.plexToken) {
      const config = getConfig();
      const plexServerUrl = config.plex?.serverUrl;

      if (plexServerUrl) {
        try {
          const plexItems = await fetchPlexWatchedItems(
            plexServerUrl,
            plexAccount.plexToken
          );
          watchedItems.push(
            ...plexItems.map((item: PlexWatchedItem) => ({
              tmdbId: item.tmdbId,
              type: item.type,
              title: item.title,
              viewCount: item.viewCount,
              lastViewedAt: item.lastViewedAt,
            }))
          );
        } catch (error) {
          console.error("[TasteProfile] Error fetching Plex watch history:", error);
        }
      }
    }

    // Fetch from Emby if available
    if (embyAccount?.embyToken && embyAccount?.embyId) {
      const config = getConfig();
      const embyServerUrl = config.emby?.serverUrl;

      if (embyServerUrl) {
        try {
          const embyItems = await fetchEmbyWatchedItems(
            embyServerUrl,
            embyAccount.embyToken,
            embyAccount.embyId
          );
          watchedItems.push(
            ...embyItems.map((item: EmbyWatchedItem) => ({
              tmdbId: item.tmdbId,
              type: item.type,
              title: item.title,
              viewCount: item.playCount,
              lastViewedAt: item.lastPlayedAt,
            }))
          );
        } catch (error) {
          console.error("[TasteProfile] Error fetching Emby watch history:", error);
        }
      }
    }

    // If no watched items, return null
    if (watchedItems.length === 0) {
      return null;
    }

    // Dedupe by tmdbId+type (prefer higher view count)
    const dedupedItems = this.dedupeWatchedItems(watchedItems);

    // Build taste profile
    const profile = await this.buildTasteProfile(userId, dedupedItems);

    // Cache the profile
    this.cache.set(userId, {
      profile,
      expiresAt: new Date(Date.now() + this.TTL_MS),
    });

    return profile;
  }

  /**
   * Deduplicate watched items by tmdbId+type
   * Keeps the item with highest view count
   */
  private dedupeWatchedItems(items: WatchedItem[]): WatchedItem[] {
    const map = new Map<string, WatchedItem>();

    for (const item of items) {
      const key = `${item.type}-${item.tmdbId}`;
      const existing = map.get(key);

      if (!existing || item.viewCount > existing.viewCount) {
        map.set(key, item);
      }
    }

    return Array.from(map.values());
  }

  /**
   * Build taste profile from watched items
   */
  private async buildTasteProfile(
    userId: string,
    watchedItems: WatchedItem[]
  ): Promise<TasteProfile> {
    // Enrich with genres from our database
    const enrichedItems = await this.enrichWithGenres(watchedItems);

    // Calculate genre weights
    const genres = this.calculateGenreWeights(enrichedItems);

    return {
      userId,
      genres,
      totalWatched: watchedItems.length,
      fetchedAt: new Date(),
    };
  }

  /**
   * Enrich watched items with genres from our MediaItem database
   */
  private async enrichWithGenres(
    items: WatchedItem[]
  ): Promise<Array<WatchedItem & { genres: string[] }>> {
    if (items.length === 0) return [];

    // Batch query our MediaItem table for genres
    const tmdbIds = items.map((item) => ({
      tmdbId: item.tmdbId,
      type: item.type === "movie" ? "MOVIE" : "TV",
    }));

    // Query in batches to avoid query size limits
    const batchSize = 100;
    const genreMap = new Map<string, string[]>();

    for (let i = 0; i < tmdbIds.length; i += batchSize) {
      const batch = tmdbIds.slice(i, i + batchSize);

      const mediaItems = await prisma.mediaItem.findMany({
        where: {
          OR: batch.map((item) => ({
            tmdbId: item.tmdbId,
            type: item.type as "MOVIE" | "TV",
          })),
        },
        select: {
          tmdbId: true,
          type: true,
          genres: true,
        },
      });

      for (const item of mediaItems) {
        const key = `${item.type.toLowerCase()}-${item.tmdbId}`;
        genreMap.set(key, item.genres);
      }
    }

    // Merge genres into watched items
    return items.map((item) => {
      const key = `${item.type}-${item.tmdbId}`;
      return {
        ...item,
        genres: genreMap.get(key) || [],
      };
    });
  }

  /**
   * Calculate genre weights from watched items
   * More recent and higher view count items have more weight
   */
  private calculateGenreWeights(
    items: Array<WatchedItem & { genres: string[] }>
  ): GenreWeight[] {
    const genreCounts = new Map<string, number>();
    const now = Date.now();
    const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;

    for (const item of items) {
      if (item.genres.length === 0) continue;

      // Base weight
      let weight = 1;

      // Bonus for multiple views
      if (item.viewCount > 1) {
        weight += Math.min(0.5, (item.viewCount - 1) * 0.1);
      }

      // Bonus for recent watches (last 90 days)
      if (item.lastViewedAt && item.lastViewedAt.getTime() > ninetyDaysAgo) {
        weight += 0.5;
      }

      // Distribute weight across genres
      for (const genre of item.genres) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + weight);
      }
    }

    if (genreCounts.size === 0) {
      return [];
    }

    // Normalize to 0-1 range
    const maxCount = Math.max(...genreCounts.values());

    return Array.from(genreCounts.entries())
      .map(([genre, count]) => ({
        genre,
        weight: count / maxCount,
        count: Math.round(count * 10) / 10, // Round to 1 decimal
      }))
      .sort((a, b) => b.weight - a.weight);
  }

  /**
   * Invalidate cache for a user
   */
  invalidateCache(userId: string): void {
    this.cache.delete(userId);
  }

  /**
   * Cleanup expired cache entries
   */
  private cleanupExpiredEntries(): void {
    const now = new Date();
    for (const [userId, cached] of this.cache.entries()) {
      if (cached.expiresAt <= now) {
        this.cache.delete(userId);
      }
    }
  }
}

// =============================================================================
// Singleton
// =============================================================================

let tasteProfileService: TasteProfileService | null = null;

export function getTasteProfileService(): TasteProfileService {
  if (!tasteProfileService) {
    tasteProfileService = new TasteProfileService();
  }
  return tasteProfileService;
}

export { TasteProfileService };
