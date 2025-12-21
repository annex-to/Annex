/**
 * Context Builder - Fluent API for creating test pipeline contexts
 *
 * Usage:
 *   const context = new ContextBuilder()
 *     .forMovie('Inception', 2010, 27205)
 *     .withTargets([{ serverId: 'server-1' }])
 *     .build();
 */

import { MediaType } from "@prisma/client";
import type { PipelineContext } from "../../PipelineContext";

export class ContextBuilder {
  private context: Partial<PipelineContext> = {
    targets: [],
  };

  forMovie(title: string, year: number, tmdbId: number): this {
    this.context.mediaType = MediaType.MOVIE;
    this.context.title = title;
    this.context.year = year;
    this.context.tmdbId = tmdbId;
    return this;
  }

  forTvShow(title: string, year: number, tmdbId: number, seasons?: number[]): this {
    this.context.mediaType = MediaType.TV;
    this.context.title = title;
    this.context.year = year;
    this.context.tmdbId = tmdbId;
    this.context.requestedSeasons = seasons || [1];
    return this;
  }

  withRequestId(requestId: string): this {
    this.context.requestId = requestId;
    return this;
  }

  withTargets(targets: Array<{ serverId: string; encodingProfileId?: string }>): this {
    this.context.targets = targets;
    return this;
  }

  withSeasons(seasons: number[]): this {
    this.context.requestedSeasons = seasons;
    return this;
  }

  withEpisodes(episodes: Array<{ season: number; episode: number }>): this {
    this.context.requestedEpisodes = episodes;
    return this;
  }

  withSearchResult(release: PipelineContext["search"]): this {
    this.context.search = release;
    return this;
  }

  withDownloadResult(download: PipelineContext["download"]): this {
    this.context.download = download;
    return this;
  }

  withEncodeResult(encode: PipelineContext["encode"]): this {
    this.context.encode = encode;
    return this;
  }

  withDeliverResult(deliver: PipelineContext["deliver"]): this {
    this.context.deliver = deliver;
    return this;
  }

  build(): PipelineContext {
    if (!this.context.requestId) {
      this.context.requestId = `test-request-${Date.now()}`;
    }

    return this.context as PipelineContext;
  }
}
