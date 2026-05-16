# SourceDownload Aggregate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Download` the canonical aggregate that owns torrent + file→episode mapping; reduce `ProcessingItem` to a thin consumer of a `DownloadFile` row. Eliminates the class of TV bugs where one source file gets delivered under multiple titles.

**Architecture:** Add `DownloadFile` model (one row per video/subtitle/extra file inside a torrent, linked 1:1 to the consuming `ProcessingItem`). Add explicit `Download.fileMapStatus` state. Extract regex-driven file mapping into a `fileMapping/` service with pluggable parsers and a confidence-scored matcher. Cut the worker pipeline over behind feature flag `ANNEX_FILE_MAPPING_V2`, with shadow comparison before drop.

**Tech Stack:** Bun, TypeScript, Prisma, PostgreSQL, `bun:test`, existing pipeline workers in `packages/server/src/services/pipeline/`.

**Spec:** `docs/source-download-spec.md`

---

## Phase 1: Schema additive migration

### Task 1: Add `DownloadFile` model and `DownloadFileMapStatus` enum

**Files:**
- Modify: `packages/server/prisma/schema.prisma`

- [ ] **Step 1: Edit `schema.prisma` — add new enum**

Append after the existing `DownloadStatus` enum:

```prisma
enum DownloadFileKind {
  VIDEO_MAIN
  VIDEO_SAMPLE
  SUBTITLE
  EXTRA
  UNKNOWN
}

enum DownloadFileMapStatus {
  PENDING
  MAPPING
  MAPPED
  FAILED
}
```

- [ ] **Step 2: Edit `schema.prisma` — add `DownloadFile` model**

Add this model immediately after the `Download` model block:

```prisma
model DownloadFile {
  id         String   @id @default(cuid())
  downloadId String
  download   Download @relation(fields: [downloadId], references: [id], onDelete: Cascade)

  relativePath String
  absolutePath String
  sizeBytes    BigInt
  fileHash     String?

  kind           DownloadFileKind @default(UNKNOWN)
  season         Int?
  episode        Int?
  episodeEnd     Int?
  airDate        DateTime?
  absoluteNumber Int?

  parserVersion String
  confidence    Float
  rejected      Boolean @default(false)
  rejectReason  String?

  processingItemId String?         @unique
  processingItem   ProcessingItem? @relation(fields: [processingItemId], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([downloadId, relativePath])
  @@index([downloadId, kind])
  @@index([processingItemId])
}
```

- [ ] **Step 3: Edit `schema.prisma` — extend `Download` model**

Locate the `Download` model. Add to the existing block (before the `// Relations` comment):

```prisma
  fileMapStatus DownloadFileMapStatus @default(PENDING)
  mapAttempts   Int                   @default(0)
```

And add to the relations block:

```prisma
  files DownloadFile[]
```

- [ ] **Step 4: Edit `schema.prisma` — extend `ProcessingItem` model**

Add a back-relation to `DownloadFile` (1:1 inverse):

```prisma
  downloadFile DownloadFile?
```

(Note: do NOT add a `downloadFileId` column on `ProcessingItem`. The `@unique` reference lives on `DownloadFile.processingItemId` per the spec; `ProcessingItem` reads via the back-relation.)

- [ ] **Step 5: Generate Prisma client**

Run: `cd packages/server && bunx prisma generate`
Expected: `✔ Generated Prisma Client`

- [ ] **Step 6: Commit**

```bash
git add packages/server/prisma/schema.prisma
git commit -m "feat(schema): add DownloadFile model and fileMapStatus

Task: SourceDownload Phase 1 - Schema additive"
```

---

### Task 2: Create migration A (additive, safe)

**Files:**
- Create: `packages/server/prisma/migrations/<timestamp>_add_download_file/migration.sql`

- [ ] **Step 1: Generate migration**

Run: `cd packages/server && bunx prisma migrate dev --name add_download_file --create-only`
Expected: a new directory under `prisma/migrations/`.

- [ ] **Step 2: Inspect the generated SQL**

Open the `migration.sql`. Verify it contains:
- `CREATE TYPE "DownloadFileKind"`
- `CREATE TYPE "DownloadFileMapStatus"`
- `CREATE TABLE "DownloadFile"`
- `ALTER TABLE "Download" ADD COLUMN "fileMapStatus"`
- `ALTER TABLE "Download" ADD COLUMN "mapAttempts"`
- Two unique indexes on `DownloadFile`

If anything is missing, edit `schema.prisma` and re-run with `--create-only`.

- [ ] **Step 3: Apply migration**

Run: `cd packages/server && bunx prisma migrate dev`
Expected: `Database is now in sync with your schema.`

- [ ] **Step 4: Commit**

```bash
git add packages/server/prisma/migrations
git commit -m "feat(db): migration for DownloadFile and fileMapStatus

Task: SourceDownload Phase 1 - Migration A"
```

---

### Task 3: Backfill script — populate `DownloadFile` from existing data

**Files:**
- Create: `packages/server/scripts/backfill-download-files.ts`
- Create: `packages/server/src/__tests__/scripts/backfillDownloadFiles.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/src/__tests__/scripts/backfillDownloadFiles.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { prisma } from "../../db/client.js";
import { backfillDownloadFiles } from "../../../scripts/backfill-download-files.js";

describe("backfillDownloadFiles", () => {
  beforeEach(async () => {
    await prisma.downloadFile.deleteMany({});
    await prisma.processingItem.deleteMany({});
    await prisma.download.deleteMany({});
    await prisma.mediaRequest.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a DownloadFile row for each ProcessingItem with sourceFilePath", async () => {
    const request = await prisma.mediaRequest.create({
      data: { tmdbId: 1, type: "TV", title: "Test Show", status: "PROCESSING" },
    });
    const download = await prisma.download.create({
      data: {
        requestId: request.id,
        torrentHash: "abc123",
        torrentName: "Test.Show.S01.Pack",
        mediaType: "TV",
        isSeasonPack: true,
        season: 1,
        status: "COMPLETED",
      },
    });
    const item = await prisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "EPISODE",
        tmdbId: 1,
        title: "Test Show",
        season: 1,
        episode: 1,
        status: "ENCODED",
        downloadId: download.id,
        sourceFilePath: "/downloads/Test.Show.S01.Pack/Test.Show.S01E01.mkv",
      },
    });

    await backfillDownloadFiles();

    const files = await prisma.downloadFile.findMany({ where: { downloadId: download.id } });
    expect(files).toHaveLength(1);
    expect(files[0].processingItemId).toBe(item.id);
    expect(files[0].absolutePath).toBe("/downloads/Test.Show.S01.Pack/Test.Show.S01E01.mkv");
    expect(files[0].season).toBe(1);
    expect(files[0].episode).toBe(1);
    expect(files[0].kind).toBe("VIDEO_MAIN");
    expect(files[0].parserVersion).toBe("backfill-v1");
  });

  it("sets Download.fileMapStatus to MAPPED when its items are at or past DOWNLOADED", async () => {
    const request = await prisma.mediaRequest.create({
      data: { tmdbId: 2, type: "MOVIE", title: "Movie", status: "PROCESSING" },
    });
    const download = await prisma.download.create({
      data: {
        requestId: request.id,
        torrentHash: "def456",
        torrentName: "Movie.2024.mkv",
        mediaType: "MOVIE",
        status: "COMPLETED",
      },
    });
    await prisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "MOVIE",
        tmdbId: 2,
        title: "Movie",
        status: "ENCODED",
        downloadId: download.id,
        sourceFilePath: "/downloads/Movie.2024.mkv",
      },
    });

    await backfillDownloadFiles();

    const reloaded = await prisma.download.findUniqueOrThrow({ where: { id: download.id } });
    expect(reloaded.fileMapStatus).toBe("MAPPED");
  });

  it("is idempotent — running twice does not duplicate rows", async () => {
    const request = await prisma.mediaRequest.create({
      data: { tmdbId: 3, type: "MOVIE", title: "M", status: "PROCESSING" },
    });
    const download = await prisma.download.create({
      data: { requestId: request.id, torrentHash: "h", torrentName: "M.mkv", mediaType: "MOVIE", status: "COMPLETED" },
    });
    await prisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "MOVIE",
        tmdbId: 3,
        title: "M",
        status: "ENCODED",
        downloadId: download.id,
        sourceFilePath: "/downloads/M.mkv",
      },
    });

    await backfillDownloadFiles();
    await backfillDownloadFiles();

    const files = await prisma.downloadFile.findMany({ where: { downloadId: download.id } });
    expect(files).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `cd packages/server && bun test src/__tests__/scripts/backfillDownloadFiles.test.ts`
Expected: module not found error for `backfill-download-files`.

- [ ] **Step 3: Implement the backfill script**

`packages/server/scripts/backfill-download-files.ts`:

```typescript
import { basename } from "node:path";
import { prisma } from "../src/db/client.js";

export async function backfillDownloadFiles(): Promise<{ filesCreated: number; downloadsMarked: number }> {
  let filesCreated = 0;
  let downloadsMarked = 0;

  const items = await prisma.processingItem.findMany({
    where: {
      sourceFilePath: { not: null },
      downloadId: { not: null },
      downloadFile: { is: null },
    },
    select: {
      id: true,
      downloadId: true,
      sourceFilePath: true,
      season: true,
      episode: true,
      type: true,
    },
  });

  for (const item of items) {
    if (!item.downloadId || !item.sourceFilePath) continue;

    const download = await prisma.download.findUnique({
      where: { id: item.downloadId },
      select: { contentPath: true, savePath: true },
    });
    if (!download) continue;

    const root = download.contentPath || download.savePath || "";
    const relativePath = root && item.sourceFilePath.startsWith(root)
      ? item.sourceFilePath.slice(root.length).replace(/^\//, "")
      : basename(item.sourceFilePath);

    await prisma.downloadFile.upsert({
      where: {
        downloadId_relativePath: { downloadId: item.downloadId, relativePath },
      },
      create: {
        downloadId: item.downloadId,
        relativePath,
        absolutePath: item.sourceFilePath,
        sizeBytes: BigInt(0),
        kind: "VIDEO_MAIN",
        season: item.season ?? undefined,
        episode: item.episode ?? undefined,
        parserVersion: "backfill-v1",
        confidence: 1.0,
        processingItemId: item.id,
      },
      update: {
        processingItemId: item.id,
      },
    });
    filesCreated += 1;
  }

  const downloads = await prisma.download.findMany({
    where: {
      fileMapStatus: "PENDING",
      processingItems: { some: { status: { in: ["DOWNLOADED", "ENCODING", "ENCODED", "DELIVERING", "COMPLETED"] } } },
    },
    select: { id: true },
  });

  for (const d of downloads) {
    await prisma.download.update({
      where: { id: d.id },
      data: { fileMapStatus: "MAPPED" },
    });
    downloadsMarked += 1;
  }

  return { filesCreated, downloadsMarked };
}

if (import.meta.main) {
  const result = await backfillDownloadFiles();
  console.log(`[backfill] Created ${result.filesCreated} DownloadFile rows, marked ${result.downloadsMarked} downloads`);
  process.exit(0);
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `cd packages/server && bun test src/__tests__/scripts/backfillDownloadFiles.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/scripts/backfill-download-files.ts packages/server/src/__tests__/scripts/backfillDownloadFiles.test.ts
git commit -m "feat(backfill): script to populate DownloadFile from existing items

Task: SourceDownload Phase 1 - Backfill"
```

---

## Phase 2: `fileMapping/` service

### Task 4: Parser interface and `seasonEpisode` parser

**Files:**
- Create: `packages/server/src/services/fileMapping/types.ts`
- Create: `packages/server/src/services/fileMapping/parsers/seasonEpisode.ts`
- Create: `packages/server/src/__tests__/services/fileMapping/parsers/seasonEpisode.test.ts`

- [ ] **Step 1: Write parser type definitions**

`packages/server/src/services/fileMapping/types.ts`:

```typescript
export interface ParsedFile {
  season?: number;
  episode?: number;
  episodeEnd?: number;
  airDate?: Date;
  absoluteNumber?: number;
  confidence: number;
  parserName: string;
}

export interface FilenameParser {
  readonly name: string;
  parse(filename: string): ParsedFile | null;
}

export const PARSER_VERSION = "v1";
```

- [ ] **Step 2: Write the failing test**

`packages/server/src/__tests__/services/fileMapping/parsers/seasonEpisode.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { seasonEpisodeParser } from "../../../../services/fileMapping/parsers/seasonEpisode.js";

describe("seasonEpisodeParser", () => {
  it("parses S01E01", () => {
    const result = seasonEpisodeParser.parse("The.Show.S01E01.1080p.mkv");
    expect(result).not.toBeNull();
    expect(result?.season).toBe(1);
    expect(result?.episode).toBe(1);
    expect(result?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("parses 1x01 form", () => {
    const result = seasonEpisodeParser.parse("Show.1x01.mkv");
    expect(result?.season).toBe(1);
    expect(result?.episode).toBe(1);
  });

  it("parses Season N Episode M form", () => {
    const result = seasonEpisodeParser.parse("Show - Season 2 Episode 5.mkv");
    expect(result?.season).toBe(2);
    expect(result?.episode).toBe(5);
  });

  it("returns null when no pattern matches", () => {
    expect(seasonEpisodeParser.parse("random.video.mkv")).toBeNull();
  });

  it("ignores resolutions that look like episodes (1080p)", () => {
    const result = seasonEpisodeParser.parse("Show.1080p.WEB-DL.mkv");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/parsers/seasonEpisode.test.ts`
Expected: module not found.

- [ ] **Step 4: Implement the parser**

`packages/server/src/services/fileMapping/parsers/seasonEpisode.ts`:

```typescript
import type { FilenameParser, ParsedFile } from "../types.js";

const PATTERNS: Array<{ regex: RegExp; confidence: number }> = [
  { regex: /S(\d{1,2})E(\d{1,2})(?!\d)/i, confidence: 0.99 },
  { regex: /\b(\d{1,2})x(\d{2})\b/i, confidence: 0.9 },
  { regex: /Season\s+(\d{1,2}).*?Episode\s+(\d{1,2})/i, confidence: 0.85 },
];

export const seasonEpisodeParser: FilenameParser = {
  name: "seasonEpisode",
  parse(filename: string): ParsedFile | null {
    for (const { regex, confidence } of PATTERNS) {
      const match = filename.match(regex);
      if (!match) continue;
      const season = Number.parseInt(match[1], 10);
      const episode = Number.parseInt(match[2], 10);
      if (Number.isNaN(season) || Number.isNaN(episode)) continue;
      return { season, episode, confidence, parserName: this.name };
    }
    return null;
  },
};
```

- [ ] **Step 5: Run the test, expect pass**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/parsers/seasonEpisode.test.ts`
Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/fileMapping packages/server/src/__tests__/services/fileMapping
git commit -m "feat(fileMapping): seasonEpisode parser

Task: SourceDownload Phase 2 - Parser interface"
```

---

### Task 5: `multiEpisode` parser

**Files:**
- Create: `packages/server/src/services/fileMapping/parsers/multiEpisode.ts`
- Create: `packages/server/src/__tests__/services/fileMapping/parsers/multiEpisode.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/src/__tests__/services/fileMapping/parsers/multiEpisode.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { multiEpisodeParser } from "../../../../services/fileMapping/parsers/multiEpisode.js";

describe("multiEpisodeParser", () => {
  it("parses S01E01E02", () => {
    const r = multiEpisodeParser.parse("Show.S01E01E02.mkv");
    expect(r?.season).toBe(1);
    expect(r?.episode).toBe(1);
    expect(r?.episodeEnd).toBe(2);
  });

  it("parses S01E01-E03", () => {
    const r = multiEpisodeParser.parse("Show.S01E01-E03.mkv");
    expect(r?.episode).toBe(1);
    expect(r?.episodeEnd).toBe(3);
  });

  it("parses S01E01-02", () => {
    const r = multiEpisodeParser.parse("Show.S01E01-02.mkv");
    expect(r?.episode).toBe(1);
    expect(r?.episodeEnd).toBe(2);
  });

  it("returns null for single episode", () => {
    expect(multiEpisodeParser.parse("Show.S01E01.mkv")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/parsers/multiEpisode.test.ts`

- [ ] **Step 3: Implement**

`packages/server/src/services/fileMapping/parsers/multiEpisode.ts`:

```typescript
import type { FilenameParser, ParsedFile } from "../types.js";

const PATTERN = /S(\d{1,2})E(\d{1,2})(?:[-E]+)(\d{1,2})/i;

export const multiEpisodeParser: FilenameParser = {
  name: "multiEpisode",
  parse(filename: string): ParsedFile | null {
    const match = filename.match(PATTERN);
    if (!match) return null;
    const season = Number.parseInt(match[1], 10);
    const episode = Number.parseInt(match[2], 10);
    const episodeEnd = Number.parseInt(match[3], 10);
    if (episodeEnd <= episode) return null;
    return { season, episode, episodeEnd, confidence: 0.97, parserName: this.name };
  },
};
```

- [ ] **Step 4: Run, expect pass**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/parsers/multiEpisode.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/fileMapping/parsers/multiEpisode.ts packages/server/src/__tests__/services/fileMapping/parsers/multiEpisode.test.ts
git commit -m "feat(fileMapping): multiEpisode parser

Task: SourceDownload Phase 2 - Multi-episode parser"
```

---

### Task 6: `dailyAir` parser

**Files:**
- Create: `packages/server/src/services/fileMapping/parsers/dailyAir.ts`
- Create: `packages/server/src/__tests__/services/fileMapping/parsers/dailyAir.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/src/__tests__/services/fileMapping/parsers/dailyAir.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { dailyAirParser } from "../../../../services/fileMapping/parsers/dailyAir.js";

describe("dailyAirParser", () => {
  it("parses 2024.05.15", () => {
    const r = dailyAirParser.parse("DailyShow.2024.05.15.mkv");
    expect(r?.airDate?.toISOString().slice(0, 10)).toBe("2024-05-15");
  });

  it("parses 2024-05-15", () => {
    const r = dailyAirParser.parse("DailyShow.2024-05-15.mkv");
    expect(r?.airDate?.toISOString().slice(0, 10)).toBe("2024-05-15");
  });

  it("rejects clearly-not-air-dates like 1080p", () => {
    expect(dailyAirParser.parse("Show.1080p.mkv")).toBeNull();
  });

  it("rejects 4-digit numbers that aren't years", () => {
    expect(dailyAirParser.parse("Show.0001.01.01.mkv")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/parsers/dailyAir.test.ts`

- [ ] **Step 3: Implement**

`packages/server/src/services/fileMapping/parsers/dailyAir.ts`:

```typescript
import type { FilenameParser, ParsedFile } from "../types.js";

const PATTERN = /(?<!\d)(19\d{2}|20\d{2})[.\-_](\d{2})[.\-_](\d{2})(?!\d)/;

export const dailyAirParser: FilenameParser = {
  name: "dailyAir",
  parse(filename: string): ParsedFile | null {
    const match = filename.match(PATTERN);
    if (!match) return null;
    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    const day = Number.parseInt(match[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const airDate = new Date(Date.UTC(year, month - 1, day));
    return { airDate, confidence: 0.8, parserName: this.name };
  },
};
```

- [ ] **Step 4: Run, expect pass**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/parsers/dailyAir.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/fileMapping/parsers/dailyAir.ts packages/server/src/__tests__/services/fileMapping/parsers/dailyAir.test.ts
git commit -m "feat(fileMapping): dailyAir parser

Task: SourceDownload Phase 2 - Daily-air parser"
```

---

### Task 7: Classifiers — sample and subtitle detection

**Files:**
- Create: `packages/server/src/services/fileMapping/classifiers/index.ts`
- Create: `packages/server/src/__tests__/services/fileMapping/classifiers.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/src/__tests__/services/fileMapping/classifiers.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { classifyFile } from "../../../services/fileMapping/classifiers/index.js";

describe("classifyFile", () => {
  it("flags sample files", () => {
    expect(classifyFile({ name: "Show.S01E01.sample.mkv", sizeBytes: 50_000_000 })).toEqual({
      kind: "VIDEO_SAMPLE",
      rejected: true,
      rejectReason: "sample",
    });
  });

  it("flags too-small video files", () => {
    expect(classifyFile({ name: "Show.S01E01.mkv", sizeBytes: 10_000_000 })).toEqual({
      kind: "VIDEO_SAMPLE",
      rejected: true,
      rejectReason: "too_small",
    });
  });

  it("classifies .srt as SUBTITLE", () => {
    const result = classifyFile({ name: "Show.S01E01.en.srt", sizeBytes: 30_000 });
    expect(result.kind).toBe("SUBTITLE");
    expect(result.rejected).toBe(false);
  });

  it("classifies .nfo as EXTRA", () => {
    expect(classifyFile({ name: "Show.nfo", sizeBytes: 1000 }).kind).toBe("EXTRA");
  });

  it("accepts a normal video file", () => {
    const result = classifyFile({ name: "Show.S01E01.1080p.mkv", sizeBytes: 2_000_000_000 });
    expect(result.kind).toBe("VIDEO_MAIN");
    expect(result.rejected).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/classifiers.test.ts`

- [ ] **Step 3: Implement**

`packages/server/src/services/fileMapping/classifiers/index.ts`:

```typescript
import type { DownloadFileKind } from "@prisma/client";

const VIDEO_EXTENSIONS = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"];
const SUBTITLE_EXTENSIONS = [".srt", ".ass", ".ssa", ".vtt", ".sub", ".idx"];
const EXTRA_EXTENSIONS = [".nfo", ".jpg", ".png", ".txt", ".sfv", ".md5"];
const SAMPLE_RE = /(?:^|[._\- ])sample(?:[._\- ]|$)/i;
const MIN_VIDEO_BYTES = 100 * 1024 * 1024;

export interface Classification {
  kind: DownloadFileKind;
  rejected: boolean;
  rejectReason?: string;
}

export function classifyFile(input: { name: string; sizeBytes: number }): Classification {
  const lower = input.name.toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
  const isSubtitle = SUBTITLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  const isExtra = EXTRA_EXTENSIONS.some((ext) => lower.endsWith(ext));

  if (isVideo) {
    if (SAMPLE_RE.test(input.name)) {
      return { kind: "VIDEO_SAMPLE", rejected: true, rejectReason: "sample" };
    }
    if (input.sizeBytes < MIN_VIDEO_BYTES) {
      return { kind: "VIDEO_SAMPLE", rejected: true, rejectReason: "too_small" };
    }
    return { kind: "VIDEO_MAIN", rejected: false };
  }
  if (isSubtitle) return { kind: "SUBTITLE", rejected: false };
  if (isExtra) return { kind: "EXTRA", rejected: false };
  return { kind: "UNKNOWN", rejected: false };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/classifiers.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/fileMapping/classifiers packages/server/src/__tests__/services/fileMapping/classifiers.test.ts
git commit -m "feat(fileMapping): file classifier

Task: SourceDownload Phase 2 - Classifier"
```

---

### Task 8: Matcher — assign parsed files to ProcessingItems

**Files:**
- Create: `packages/server/src/services/fileMapping/matcher.ts`
- Create: `packages/server/src/__tests__/services/fileMapping/matcher.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/src/__tests__/services/fileMapping/matcher.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { matchFilesToItems } from "../../../services/fileMapping/matcher.js";

const candidateFile = (overrides: { season?: number; episode?: number; episodeEnd?: number; relativePath: string }) => ({
  relativePath: overrides.relativePath,
  parsed: {
    season: overrides.season,
    episode: overrides.episode,
    episodeEnd: overrides.episodeEnd,
    confidence: 0.99,
    parserName: "seasonEpisode",
  },
});

describe("matchFilesToItems", () => {
  it("matches a single S01E01 file to the S01E01 item", () => {
    const result = matchFilesToItems({
      files: [candidateFile({ season: 1, episode: 1, relativePath: "Show.S01E01.mkv" })],
      items: [{ id: "pi1", season: 1, episode: 1 }],
    });
    expect(result.assignments).toEqual([{ relativePath: "Show.S01E01.mkv", processingItemId: "pi1" }]);
    expect(result.misses).toEqual([]);
    expect(result.orphans).toEqual([]);
  });

  it("assigns multi-episode file to lowest-episode PI only and marks the rest as miss (v1 scope)", () => {
    const result = matchFilesToItems({
      files: [candidateFile({ season: 1, episode: 1, episodeEnd: 2, relativePath: "Show.S01E01E02.mkv" })],
      items: [
        { id: "pi1", season: 1, episode: 1 },
        { id: "pi2", season: 1, episode: 2 },
      ],
    });
    expect(result.assignments).toEqual([{ relativePath: "Show.S01E01E02.mkv", processingItemId: "pi1" }]);
    expect(result.misses).toEqual(["pi2"]);
  });

  it("returns orphans when a file matches no item", () => {
    const result = matchFilesToItems({
      files: [candidateFile({ season: 1, episode: 99, relativePath: "Show.S01E99.mkv" })],
      items: [{ id: "pi1", season: 1, episode: 1 }],
    });
    expect(result.orphans).toEqual(["Show.S01E99.mkv"]);
    expect(result.misses).toEqual(["pi1"]);
  });

  it("returns misses when an item has no file", () => {
    const result = matchFilesToItems({
      files: [candidateFile({ season: 1, episode: 1, relativePath: "Show.S01E01.mkv" })],
      items: [
        { id: "pi1", season: 1, episode: 1 },
        { id: "pi2", season: 1, episode: 2 },
      ],
    });
    expect(result.misses).toEqual(["pi2"]);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/matcher.test.ts`

- [ ] **Step 3: Implement**

`packages/server/src/services/fileMapping/matcher.ts`:

```typescript
import type { ParsedFile } from "./types.js";

export interface MatcherFile {
  relativePath: string;
  parsed: ParsedFile;
}

export interface MatcherItem {
  id: string;
  season?: number | null;
  episode?: number | null;
}

export interface MatchResult {
  assignments: Array<{ relativePath: string; processingItemId: string }>;
  orphans: string[];
  misses: string[];
}

export function matchFilesToItems(input: { files: MatcherFile[]; items: MatcherItem[] }): MatchResult {
  const assignments: MatchResult["assignments"] = [];
  const matchedItemIds = new Set<string>();
  const orphans: string[] = [];

  // v1: DownloadFile.processingItemId is @unique, so each file links to exactly one PI.
  // Multi-episode files attach to the lowest-numbered PI in their range; the rest become misses.
  // See "Open questions" in spec for the future multi-PI design.
  for (const file of input.files) {
    const { season, episode } = file.parsed;
    if (season === undefined || episode === undefined) {
      orphans.push(file.relativePath);
      continue;
    }
    const item = input.items.find((i) => i.season === season && i.episode === episode);
    if (item) {
      assignments.push({ relativePath: file.relativePath, processingItemId: item.id });
      matchedItemIds.add(item.id);
    } else {
      orphans.push(file.relativePath);
    }
  }

  const misses = input.items.filter((i) => !matchedItemIds.has(i.id)).map((i) => i.id);
  return { assignments, orphans, misses };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/matcher.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/fileMapping/matcher.ts packages/server/src/__tests__/services/fileMapping/matcher.test.ts
git commit -m "feat(fileMapping): confidence-scored matcher

Task: SourceDownload Phase 2 - Matcher"
```

---

### Task 9: `mapDownloadFiles` entry point

**Files:**
- Create: `packages/server/src/services/fileMapping/index.ts`
- Create: `packages/server/src/__tests__/services/fileMapping/index.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/src/__tests__/services/fileMapping/index.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterAll, mock } from "bun:test";
import { prisma } from "../../../db/client.js";

const fakeFiles = [
  { name: "Show.S01E01.1080p.mkv", size: 2_000_000_000 },
  { name: "Show.S01E02.1080p.mkv", size: 2_000_000_000 },
  { name: "Show.sample.mkv", size: 50_000_000 },
];

mock.module("../../../services/downloadClients/DownloadClientManager.js", () => ({
  getDownloadClientManager: () => ({
    getTorrentFiles: async () => fakeFiles,
    getProgress: async () => ({ savePath: "/downloads/Show.S01" }),
  }),
}));

const { mapDownloadFiles } = await import("../../../services/fileMapping/index.js");

describe("mapDownloadFiles", () => {
  beforeEach(async () => {
    await prisma.downloadFile.deleteMany({});
    await prisma.processingItem.deleteMany({});
    await prisma.download.deleteMany({});
    await prisma.mediaRequest.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates DownloadFile rows for video files, links PIs, rejects samples", async () => {
    const request = await prisma.mediaRequest.create({
      data: { tmdbId: 10, type: "TV", title: "Show", status: "PROCESSING" },
    });
    const download = await prisma.download.create({
      data: { requestId: request.id, torrentHash: "h1", torrentName: "Show.S01", mediaType: "TV", isSeasonPack: true, season: 1, status: "COMPLETED" },
    });
    const e1 = await prisma.processingItem.create({
      data: { requestId: request.id, type: "EPISODE", tmdbId: 10, title: "Show", season: 1, episode: 1, status: "DOWNLOADING", downloadId: download.id },
    });
    const e2 = await prisma.processingItem.create({
      data: { requestId: request.id, type: "EPISODE", tmdbId: 10, title: "Show", season: 1, episode: 2, status: "DOWNLOADING", downloadId: download.id },
    });

    const result = await mapDownloadFiles(download.id);
    expect(result.fileMapStatus).toBe("MAPPED");

    const files = await prisma.downloadFile.findMany({ where: { downloadId: download.id }, orderBy: { relativePath: "asc" } });
    expect(files).toHaveLength(3);
    const sample = files.find((f) => f.rejectReason === "sample");
    expect(sample).toBeDefined();
    expect(files.find((f) => f.processingItemId === e1.id)).toBeDefined();
    expect(files.find((f) => f.processingItemId === e2.id)).toBeDefined();
  });

  it("is idempotent — second call does not duplicate rows", async () => {
    const request = await prisma.mediaRequest.create({ data: { tmdbId: 11, type: "TV", title: "Show", status: "PROCESSING" } });
    const download = await prisma.download.create({
      data: { requestId: request.id, torrentHash: "h2", torrentName: "Show", mediaType: "TV", isSeasonPack: true, season: 1, status: "COMPLETED" },
    });
    await prisma.processingItem.create({
      data: { requestId: request.id, type: "EPISODE", tmdbId: 11, title: "Show", season: 1, episode: 1, status: "DOWNLOADING", downloadId: download.id },
    });
    await prisma.processingItem.create({
      data: { requestId: request.id, type: "EPISODE", tmdbId: 11, title: "Show", season: 1, episode: 2, status: "DOWNLOADING", downloadId: download.id },
    });

    await mapDownloadFiles(download.id);
    await mapDownloadFiles(download.id);

    const count = await prisma.downloadFile.count({ where: { downloadId: download.id } });
    expect(count).toBe(3);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/index.test.ts`

- [ ] **Step 3: Implement**

`packages/server/src/services/fileMapping/index.ts`:

```typescript
import { prisma } from "../../db/client.js";
import { getDownloadClientManager } from "../downloadClients/DownloadClientManager.js";
import { classifyFile } from "./classifiers/index.js";
import { matchFilesToItems } from "./matcher.js";
import { dailyAirParser } from "./parsers/dailyAir.js";
import { multiEpisodeParser } from "./parsers/multiEpisode.js";
import { seasonEpisodeParser } from "./parsers/seasonEpisode.js";
import { PARSER_VERSION, type FilenameParser, type ParsedFile } from "./types.js";

const PARSERS: FilenameParser[] = [multiEpisodeParser, seasonEpisodeParser, dailyAirParser];

function parseFilename(filename: string): ParsedFile {
  for (const parser of PARSERS) {
    const result = parser.parse(filename);
    if (result) return result;
  }
  return { confidence: 0, parserName: "none" };
}

export async function mapDownloadFiles(downloadId: string): Promise<{ fileMapStatus: "MAPPED" | "FAILED"; orphans: string[]; misses: string[] }> {
  const download = await prisma.download.findUniqueOrThrow({
    where: { id: downloadId },
    select: { id: true, torrentHash: true, contentPath: true, savePath: true, requestId: true },
  });

  await prisma.download.update({ where: { id: downloadId }, data: { fileMapStatus: "MAPPING" } });

  const clientManager = getDownloadClientManager();
  const torrentFiles = await clientManager.getTorrentFiles(download.torrentHash);
  const progress = await clientManager.getProgress(download.torrentHash);
  const root = download.contentPath || download.savePath || progress?.savePath || "";

  const items = await prisma.processingItem.findMany({
    where: { downloadId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true, season: true, episode: true },
  });

  const matcherFiles = [];

  for (const file of torrentFiles) {
    const classification = classifyFile({ name: file.name, sizeBytes: file.size });
    const parsed = classification.kind === "VIDEO_MAIN" ? parseFilename(file.name) : { confidence: 0, parserName: "none" };
    const absolutePath = root ? `${root.replace(/\/$/, "")}/${file.name}` : file.name;

    await prisma.downloadFile.upsert({
      where: { downloadId_relativePath: { downloadId, relativePath: file.name } },
      create: {
        downloadId,
        relativePath: file.name,
        absolutePath,
        sizeBytes: BigInt(file.size),
        kind: classification.kind,
        season: parsed.season,
        episode: parsed.episode,
        episodeEnd: parsed.episodeEnd,
        airDate: parsed.airDate,
        absoluteNumber: parsed.absoluteNumber,
        parserVersion: PARSER_VERSION,
        confidence: parsed.confidence,
        rejected: classification.rejected,
        rejectReason: classification.rejectReason,
      },
      update: {
        absolutePath,
        sizeBytes: BigInt(file.size),
        kind: classification.kind,
        season: parsed.season,
        episode: parsed.episode,
        episodeEnd: parsed.episodeEnd,
        airDate: parsed.airDate,
        absoluteNumber: parsed.absoluteNumber,
        parserVersion: PARSER_VERSION,
        confidence: parsed.confidence,
        rejected: classification.rejected,
        rejectReason: classification.rejectReason,
      },
    });

    if (classification.kind === "VIDEO_MAIN" && !classification.rejected) {
      matcherFiles.push({ relativePath: file.name, parsed });
    }
  }

  const match = matchFilesToItems({ files: matcherFiles, items });

  for (const assignment of match.assignments) {
    await prisma.downloadFile.update({
      where: { downloadId_relativePath: { downloadId, relativePath: assignment.relativePath } },
      data: { processingItemId: assignment.processingItemId },
    });
  }

  await prisma.download.update({ where: { id: downloadId }, data: { fileMapStatus: "MAPPED" } });
  return { fileMapStatus: "MAPPED", orphans: match.orphans, misses: match.misses };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/index.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/fileMapping/index.ts packages/server/src/__tests__/services/fileMapping/index.test.ts
git commit -m "feat(fileMapping): mapDownloadFiles entry point

Task: SourceDownload Phase 2 - Entry point"
```

---

## Phase 3: FileMapWorker

### Task 10: `FileMapWorker` polling for `Download.fileMapStatus = PENDING`

**Files:**
- Create: `packages/server/src/services/pipeline/workers/FileMapWorker.ts`
- Create: `packages/server/src/__tests__/services/pipeline/workers/FileMapWorker.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/src/__tests__/services/pipeline/workers/FileMapWorker.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterAll, mock } from "bun:test";
import { prisma } from "../../../../db/client.js";

mock.module("../../../../services/fileMapping/index.js", () => ({
  mapDownloadFiles: async (id: string) => {
    await prisma.download.update({ where: { id }, data: { fileMapStatus: "MAPPED" } });
    await prisma.processingItem.updateMany({
      where: { downloadId: id, status: "DOWNLOADING" },
      data: { status: "DOWNLOADED" },
    });
    return { fileMapStatus: "MAPPED" as const, orphans: [], misses: [] };
  },
}));

const { FileMapWorker } = await import("../../../../services/pipeline/workers/FileMapWorker.js");

describe("FileMapWorker", () => {
  beforeEach(async () => {
    await prisma.downloadFile.deleteMany({});
    await prisma.processingItem.deleteMany({});
    await prisma.download.deleteMany({});
    await prisma.mediaRequest.deleteMany({});
  });

  afterAll(async () => prisma.$disconnect());

  it("processes a PENDING download whose torrent is COMPLETED", async () => {
    const request = await prisma.mediaRequest.create({ data: { tmdbId: 50, type: "TV", title: "S", status: "PROCESSING" } });
    const download = await prisma.download.create({
      data: { requestId: request.id, torrentHash: "x", torrentName: "S", mediaType: "TV", status: "COMPLETED", fileMapStatus: "PENDING" },
    });
    const item = await prisma.processingItem.create({
      data: { requestId: request.id, type: "EPISODE", tmdbId: 50, title: "S", season: 1, episode: 1, status: "DOWNLOADING", downloadId: download.id },
    });

    const worker = new FileMapWorker();
    await worker.processBatch();

    const reloaded = await prisma.download.findUniqueOrThrow({ where: { id: download.id } });
    expect(reloaded.fileMapStatus).toBe("MAPPED");
    const itemReloaded = await prisma.processingItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(itemReloaded.status).toBe("DOWNLOADED");
  });

  it("skips downloads whose torrent is still DOWNLOADING", async () => {
    const request = await prisma.mediaRequest.create({ data: { tmdbId: 51, type: "TV", title: "S", status: "PROCESSING" } });
    const download = await prisma.download.create({
      data: { requestId: request.id, torrentHash: "y", torrentName: "S", mediaType: "TV", status: "DOWNLOADING", fileMapStatus: "PENDING" },
    });

    const worker = new FileMapWorker();
    await worker.processBatch();

    const reloaded = await prisma.download.findUniqueOrThrow({ where: { id: download.id } });
    expect(reloaded.fileMapStatus).toBe("PENDING");
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd packages/server && bun test src/__tests__/services/pipeline/workers/FileMapWorker.test.ts`

- [ ] **Step 3: Implement**

`packages/server/src/services/pipeline/workers/FileMapWorker.ts`:

```typescript
import { prisma } from "../../../db/client.js";
import { mapDownloadFiles } from "../../fileMapping/index.js";

const MAX_ATTEMPTS = 3;

export class FileMapWorker {
  readonly name = "FileMapWorker";

  async processBatch(): Promise<void> {
    const pending = await prisma.download.findMany({
      where: {
        fileMapStatus: "PENDING",
        status: "COMPLETED",
        mapAttempts: { lt: MAX_ATTEMPTS },
      },
      orderBy: { updatedAt: "asc" },
      take: 10,
      select: { id: true },
    });

    for (const { id } of pending) {
      try {
        await prisma.download.update({
          where: { id },
          data: { mapAttempts: { increment: 1 } },
        });
        await mapDownloadFiles(id);
      } catch (error) {
        console.error(`[${this.name}] Failed to map files for download ${id}:`, error);
        const current = await prisma.download.findUnique({ where: { id }, select: { mapAttempts: true } });
        if (current && current.mapAttempts >= MAX_ATTEMPTS) {
          await prisma.download.update({ where: { id }, data: { fileMapStatus: "FAILED" } });
        } else {
          await prisma.download.update({ where: { id }, data: { fileMapStatus: "PENDING" } });
        }
      }
    }
  }
}

export const fileMapWorker = new FileMapWorker();
```

- [ ] **Step 4: Run, expect pass**

Run: `cd packages/server && bun test src/__tests__/services/pipeline/workers/FileMapWorker.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/pipeline/workers/FileMapWorker.ts packages/server/src/__tests__/services/pipeline/workers/FileMapWorker.test.ts
git commit -m "feat(workers): FileMapWorker polls PENDING downloads

Task: SourceDownload Phase 3 - Worker"
```

---

### Task 11: Register `FileMapWorker` in the worker pool

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Locate the worker registration block**

Run: `grep -n "downloadWorker\|encodeWorker\|deliverWorker" packages/server/src/index.ts`
Expected: lines where existing workers are started.

- [ ] **Step 2: Add the FileMapWorker import**

Add to the worker imports near the other worker imports:

```typescript
import { fileMapWorker } from "./services/pipeline/workers/FileMapWorker.js";
```

- [ ] **Step 3: Add to the polling schedule**

Following the same pattern as the existing workers (look for `setInterval(() => downloadWorker.processBatch()` or equivalent), add:

```typescript
setInterval(() => fileMapWorker.processBatch().catch((err) => console.error("[FileMapWorker] poll error:", err)), 10_000);
```

- [ ] **Step 4: Build to verify wiring**

Run: `cd packages/server && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(server): register FileMapWorker in poll loop

Task: SourceDownload Phase 3 - Wire worker"
```

---

## Phase 4: DownloadStep cutover behind feature flag

### Task 12: Add feature flag plumbing

**Files:**
- Create: `packages/server/src/services/fileMapping/featureFlag.ts`
- Create: `packages/server/src/__tests__/services/fileMapping/featureFlag.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/src/__tests__/services/fileMapping/featureFlag.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";

describe("fileMappingV2Enabled", () => {
  const original = process.env.ANNEX_FILE_MAPPING_V2;

  afterEach(() => {
    if (original === undefined) delete process.env.ANNEX_FILE_MAPPING_V2;
    else process.env.ANNEX_FILE_MAPPING_V2 = original;
  });

  it("returns false by default", async () => {
    delete process.env.ANNEX_FILE_MAPPING_V2;
    const { fileMappingV2Enabled } = await import("../../../services/fileMapping/featureFlag.js?cb1");
    expect(fileMappingV2Enabled()).toBe(false);
  });

  it("returns true when ANNEX_FILE_MAPPING_V2=true", async () => {
    process.env.ANNEX_FILE_MAPPING_V2 = "true";
    const { fileMappingV2Enabled } = await import("../../../services/fileMapping/featureFlag.js?cb2");
    expect(fileMappingV2Enabled()).toBe(true);
  });

  it("returns true when ANNEX_FILE_MAPPING_V2=1", async () => {
    process.env.ANNEX_FILE_MAPPING_V2 = "1";
    const { fileMappingV2Enabled } = await import("../../../services/fileMapping/featureFlag.js?cb3");
    expect(fileMappingV2Enabled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/featureFlag.test.ts`

- [ ] **Step 3: Implement**

`packages/server/src/services/fileMapping/featureFlag.ts`:

```typescript
export function fileMappingV2Enabled(): boolean {
  const value = process.env.ANNEX_FILE_MAPPING_V2;
  return value === "true" || value === "1";
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd packages/server && bun test src/__tests__/services/fileMapping/featureFlag.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/fileMapping/featureFlag.ts packages/server/src/__tests__/services/fileMapping/featureFlag.test.ts
git commit -m "feat(fileMapping): feature flag

Task: SourceDownload Phase 4 - Feature flag"
```

---

### Task 13: Shadow mode in `DownloadStep.extractEpisodeFiles`

Run both old and new mapping; log disagreements. No behavior change yet.

**Files:**
- Modify: `packages/server/src/services/pipeline/steps/DownloadStep.ts:700-870`
- Create: `packages/server/src/__tests__/services/pipeline/steps/DownloadStepShadow.test.ts`

- [ ] **Step 1: Locate `extractEpisodeFiles`**

Run: `grep -n "extractEpisodeFiles\|return episodeFiles;" packages/server/src/services/pipeline/steps/DownloadStep.ts`
Expected: declarations near lines 703 and 869.

- [ ] **Step 2: Write the failing test**

`packages/server/src/__tests__/services/pipeline/steps/DownloadStepShadow.test.ts`:

```typescript
import { describe, expect, it, mock } from "bun:test";

let mapCalls = 0;
mock.module("../../../../services/fileMapping/index.js", () => ({
  mapDownloadFiles: async (id: string) => {
    mapCalls += 1;
    return { fileMapStatus: "MAPPED" as const, orphans: [], misses: [] };
  },
}));

mock.module("../../../../services/fileMapping/featureFlag.js", () => ({
  fileMappingV2Enabled: () => false,
}));

const { runShadowMapping } = await import("../../../../services/pipeline/steps/DownloadStep.js");

describe("runShadowMapping", () => {
  it("invokes mapDownloadFiles even when feature flag is off", async () => {
    mapCalls = 0;
    await runShadowMapping("dl-id");
    expect(mapCalls).toBe(1);
  });

  it("swallows errors from mapDownloadFiles so the legacy path is not disturbed", async () => {
    mock.module("../../../../services/fileMapping/index.js", () => ({
      mapDownloadFiles: async () => {
        throw new Error("boom");
      },
    }));
    await expect(runShadowMapping("dl-id")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run, expect failure (`runShadowMapping` not exported)**

Run: `cd packages/server && bun test src/__tests__/services/pipeline/steps/DownloadStepShadow.test.ts`

- [ ] **Step 4: Export a `runShadowMapping` helper from `DownloadStep.ts`**

At the top of `DownloadStep.ts`, add the imports:

```typescript
import { mapDownloadFiles } from "../../fileMapping/index.js";
import { fileMappingV2Enabled } from "../../fileMapping/featureFlag.js";
```

Just below the imports, add:

```typescript
export async function runShadowMapping(downloadId: string): Promise<void> {
  try {
    await mapDownloadFiles(downloadId);
  } catch (error) {
    console.warn(`[DownloadStep] Shadow mapping failed for ${downloadId}:`, error);
  }
}
```

In `extractEpisodeFiles`, immediately after the line `if (!download) { throw new Error(...) }`, add:

```typescript
    if (!fileMappingV2Enabled()) {
      // Shadow: run new mapper in background for comparison; do not block legacy path.
      void runShadowMapping(download.id);
    }
```

- [ ] **Step 5: Run, expect pass**

Run: `cd packages/server && bun test src/__tests__/services/pipeline/steps/DownloadStepShadow.test.ts`

- [ ] **Step 6: Typecheck**

Run: `cd packages/server && bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/pipeline/steps/DownloadStep.ts packages/server/src/__tests__/services/pipeline/steps/DownloadStepShadow.test.ts
git commit -m "feat(downloadStep): shadow-mode mapping comparison

Task: SourceDownload Phase 4 - Shadow mode"
```

---

### Task 14: Switch `extractEpisodeFiles` to v2 path when flag on

**Files:**
- Modify: `packages/server/src/services/pipeline/steps/DownloadStep.ts:703-870`
- Create: `packages/server/src/__tests__/services/pipeline/steps/DownloadStepV2.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/src/__tests__/services/pipeline/steps/DownloadStepV2.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterAll, mock } from "bun:test";
import { prisma } from "../../../../db/client.js";

mock.module("../../../../services/fileMapping/featureFlag.js", () => ({
  fileMappingV2Enabled: () => true,
}));

mock.module("../../../../services/fileMapping/index.js", () => ({
  mapDownloadFiles: async (id: string) => {
    const items = await prisma.processingItem.findMany({ where: { downloadId: id } });
    for (const item of items) {
      await prisma.downloadFile.create({
        data: {
          downloadId: id,
          relativePath: `S01E0${item.episode}.mkv`,
          absolutePath: `/dl/S01E0${item.episode}.mkv`,
          sizeBytes: BigInt(2_000_000_000),
          kind: "VIDEO_MAIN",
          season: 1,
          episode: item.episode,
          parserVersion: "v1",
          confidence: 0.99,
          processingItemId: item.id,
        },
      });
      await prisma.processingItem.update({ where: { id: item.id }, data: { status: "DOWNLOADED" } });
    }
    await prisma.download.update({ where: { id }, data: { fileMapStatus: "MAPPED" } });
    return { fileMapStatus: "MAPPED" as const, orphans: [], misses: [] };
  },
}));

const { DownloadStep } = await import("../../../../services/pipeline/steps/DownloadStep.js");

describe("DownloadStep.extractEpisodeFiles (v2)", () => {
  beforeEach(async () => {
    await prisma.downloadFile.deleteMany({});
    await prisma.processingItem.deleteMany({});
    await prisma.download.deleteMany({});
    await prisma.mediaRequest.deleteMany({});
  });

  afterAll(async () => prisma.$disconnect());

  it("delegates to mapDownloadFiles and returns episodeFiles from DownloadFile rows", async () => {
    const request = await prisma.mediaRequest.create({ data: { tmdbId: 70, type: "TV", title: "Show", status: "PROCESSING" } });
    const download = await prisma.download.create({
      data: { requestId: request.id, torrentHash: "v2hash", torrentName: "Show.S01", mediaType: "TV", isSeasonPack: true, season: 1, status: "COMPLETED" },
    });
    await prisma.processingItem.createMany({
      data: [
        { requestId: request.id, type: "EPISODE", tmdbId: 70, title: "Show", season: 1, episode: 1, status: "DOWNLOADING", downloadId: download.id },
        { requestId: request.id, type: "EPISODE", tmdbId: 70, title: "Show", season: 1, episode: 2, status: "DOWNLOADING", downloadId: download.id },
      ],
    });

    const step = new DownloadStep();
    const files = await (step as unknown as { extractEpisodeFiles(torrentHash: string, requestId: string): Promise<unknown[]> }).extractEpisodeFiles("v2hash", request.id);
    expect(files).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd packages/server && bun test src/__tests__/services/pipeline/steps/DownloadStepV2.test.ts`

- [ ] **Step 3: Refactor `extractEpisodeFiles`**

In `DownloadStep.ts`, at the top of `extractEpisodeFiles` (right after the `getDownloadService()` line), insert:

```typescript
    if (fileMappingV2Enabled()) {
      return await this.extractEpisodeFilesV2(torrentHash, requestId);
    }
```

Add a new method below `extractEpisodeFiles`:

```typescript
  private async extractEpisodeFilesV2(
    torrentHash: string,
    requestId: string
  ): Promise<Array<{ season: number; episode: number; path: string; size: number; episodeId: string }>> {
    const download = await prisma.download.findFirst({
      where: { torrentHash },
      select: { id: true },
    });
    if (!download) {
      throw new Error(`Download not found for torrent ${torrentHash}`);
    }

    await mapDownloadFiles(download.id);

    const rows = await prisma.downloadFile.findMany({
      where: {
        downloadId: download.id,
        kind: "VIDEO_MAIN",
        rejected: false,
        processingItemId: { not: null },
        processingItem: { requestId },
      },
      include: { processingItem: { select: { id: true } } },
    });

    return rows
      .filter((r) => r.season !== null && r.episode !== null && r.processingItemId !== null)
      .map((r) => ({
        season: r.season!,
        episode: r.episode!,
        path: r.absolutePath,
        size: Number(r.sizeBytes),
        episodeId: r.processingItemId!,
      }))
      .sort((a, b) => (a.season !== b.season ? a.season - b.season : a.episode - b.episode));
  }
```

- [ ] **Step 4: Run, expect pass**

Run: `cd packages/server && bun test src/__tests__/services/pipeline/steps/DownloadStepV2.test.ts`

- [ ] **Step 5: Typecheck**

Run: `cd packages/server && bunx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/pipeline/steps/DownloadStep.ts packages/server/src/__tests__/services/pipeline/steps/DownloadStepV2.test.ts
git commit -m "feat(downloadStep): v2 path uses DownloadFile rows behind flag

Task: SourceDownload Phase 4 - v2 cutover"
```

---

## Phase 5: EncodeWorker reads from `DownloadFile`

### Task 15: `EncodeWorker` prefers `processingItem.downloadFile.absolutePath`

**Files:**
- Modify: `packages/server/src/services/pipeline/workers/EncodeWorker.ts:161-180`
- Create: `packages/server/src/__tests__/services/pipeline/workers/EncodeWorkerReadsDownloadFile.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/src/__tests__/services/pipeline/workers/EncodeWorkerReadsDownloadFile.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { prisma } from "../../../../db/client.js";
import { resolveSourceFilePath } from "../../../../services/pipeline/workers/EncodeWorker.js";

describe("resolveSourceFilePath", () => {
  beforeEach(async () => {
    await prisma.downloadFile.deleteMany({});
    await prisma.processingItem.deleteMany({});
    await prisma.download.deleteMany({});
    await prisma.mediaRequest.deleteMany({});
  });

  afterAll(async () => prisma.$disconnect());

  it("returns the DownloadFile.absolutePath when one exists", async () => {
    const request = await prisma.mediaRequest.create({ data: { tmdbId: 200, type: "TV", title: "S", status: "PROCESSING" } });
    const download = await prisma.download.create({
      data: { requestId: request.id, torrentHash: "z1", torrentName: "S", mediaType: "TV", status: "COMPLETED" },
    });
    const item = await prisma.processingItem.create({
      data: { requestId: request.id, type: "EPISODE", tmdbId: 200, title: "S", season: 1, episode: 1, status: "DOWNLOADED", downloadId: download.id },
    });
    await prisma.downloadFile.create({
      data: {
        downloadId: download.id,
        relativePath: "S01E01.mkv",
        absolutePath: "/files/S01E01.mkv",
        sizeBytes: BigInt(1_000_000_000),
        kind: "VIDEO_MAIN",
        parserVersion: "v1",
        confidence: 0.99,
        processingItemId: item.id,
      },
    });

    const reloaded = await prisma.processingItem.findUniqueOrThrow({ where: { id: item.id } });
    const path = await resolveSourceFilePath(reloaded);
    expect(path).toBe("/files/S01E01.mkv");
  });

  it("falls back to stepContext.download.sourceFilePath when no DownloadFile", async () => {
    const request = await prisma.mediaRequest.create({ data: { tmdbId: 201, type: "TV", title: "S", status: "PROCESSING" } });
    const download = await prisma.download.create({ data: { requestId: request.id, torrentHash: "z2", torrentName: "S", mediaType: "TV", status: "COMPLETED" } });
    const item = await prisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "EPISODE",
        tmdbId: 201,
        title: "S",
        season: 1,
        episode: 1,
        status: "DOWNLOADED",
        downloadId: download.id,
        stepContext: { download: { sourceFilePath: "/legacy/path.mkv", torrentHash: "z2" } },
      },
    });

    const path = await resolveSourceFilePath(item);
    expect(path).toBe("/legacy/path.mkv");
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd packages/server && bun test src/__tests__/services/pipeline/workers/EncodeWorkerReadsDownloadFile.test.ts`

- [ ] **Step 3: Add `resolveSourceFilePath` to `EncodeWorker.ts`**

In `EncodeWorker.ts`, just above `export class EncodeWorker`, add:

```typescript
export async function resolveSourceFilePath(item: ProcessingItem): Promise<string | null> {
  const file = await prisma.downloadFile.findUnique({
    where: { processingItemId: item.id },
    select: { absolutePath: true },
  });
  if (file) return file.absolutePath;
  const ctx = (item.stepContext as Record<string, unknown> | null) ?? {};
  const dl = ctx.download as { sourceFilePath?: string } | undefined;
  return dl?.sourceFilePath ?? null;
}
```

- [ ] **Step 4: Replace `downloadData.sourceFilePath` reads inside `createEncodingJob`**

In `EncodeWorker.ts`, locate the block:

```typescript
    const stepContext = item.stepContext as Record<string, unknown>;
    const downloadData = stepContext.download as PipelineContext["download"];

    if (!downloadData?.sourceFilePath) {
      throw new Error("No download data found in item context");
    }
```

Replace with:

```typescript
    const sourceFilePath = await resolveSourceFilePath(item);
    if (!sourceFilePath) {
      throw new Error("No source file path resolved for item");
    }
    const stepContext = item.stepContext as Record<string, unknown>;
    const downloadData = (stepContext.download as PipelineContext["download"] | undefined) ?? { torrentHash: "" };
    downloadData.sourceFilePath = sourceFilePath;
```

This keeps the rest of the method (which reads `downloadData.sourceFilePath`) working unchanged.

- [ ] **Step 5: Run, expect pass**

Run: `cd packages/server && bun test src/__tests__/services/pipeline/workers/EncodeWorkerReadsDownloadFile.test.ts`

- [ ] **Step 6: Typecheck**

Run: `cd packages/server && bunx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/pipeline/workers/EncodeWorker.ts packages/server/src/__tests__/services/pipeline/workers/EncodeWorkerReadsDownloadFile.test.ts
git commit -m "feat(encodeWorker): resolve source path from DownloadFile first

Task: SourceDownload Phase 5 - EncodeWorker reads"
```

---

## Phase 6: Cross-request safety

### Task 16: PI title check before attaching to existing Download

**Files:**
- Modify: `packages/server/src/services/downloadManager.ts:725-810`
- Create: `packages/server/src/__tests__/services/downloadManagerTitleGuard.test.ts`

- [ ] **Step 1: Locate `createDownloadFromExisting`**

Run: `grep -n "createDownloadFromExisting" packages/server/src/services/downloadManager.ts`

- [ ] **Step 2: Write the failing test**

`packages/server/src/__tests__/services/downloadManagerTitleGuard.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { normalizedTitlesMatch } from "../../services/downloadManager.js";

describe("normalizedTitlesMatch", () => {
  it("matches identical titles", () => {
    expect(normalizedTitlesMatch("The Office", "the office")).toBe(true);
  });
  it("treats punctuation and spacing differences as matching", () => {
    expect(normalizedTitlesMatch("The Office: US", "the.office.us")).toBe(true);
  });
  it("rejects different shows that share a word", () => {
    expect(normalizedTitlesMatch("The Office", "The Office UK")).toBe(false);
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `cd packages/server && bun test src/__tests__/services/downloadManagerTitleGuard.test.ts`

- [ ] **Step 4: Implement and export `normalizedTitlesMatch`**

In `downloadManager.ts`, add (near the existing `normalizeTitle` import or definition):

```typescript
export function normalizedTitlesMatch(a: string, b: string): boolean {
  return normalizeTitle(a) === normalizeTitle(b);
}
```

(`normalizeTitle` already exists in the file.)

- [ ] **Step 5: Add the guard inside `createDownloadFromExisting`**

In the branch where `existing` is found (after `const existing = await prisma.download.findUnique({ where: { torrentHash: match.torrent.hash } });`), before linking episodes, insert:

```typescript
  if (existing && existing.torrentName) {
    const request = await prisma.mediaRequest.findUnique({ where: { id: requestId }, select: { title: true } });
    if (request?.title && !normalizedTitlesMatch(request.title, existing.torrentName)) {
      console.warn(
        `[DownloadManager] Refusing to attach request ${requestId} (title="${request.title}") to existing download ${existing.id} (torrent="${existing.torrentName}") — titles do not match`
      );
      return null as unknown as Download;
    }
  }
```

Update the return type of the function to `Promise<Download | null>` and update callers to check for `null`. Use `grep -n "createDownloadFromExisting(" packages/server/src/` to find them; each call site should treat `null` as "fall through to a fresh download".

- [ ] **Step 6: Run, expect pass on the new test**

Run: `cd packages/server && bun test src/__tests__/services/downloadManagerTitleGuard.test.ts`

- [ ] **Step 7: Typecheck**

Run: `cd packages/server && bunx tsc --noEmit`

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/services/downloadManager.ts packages/server/src/__tests__/services/downloadManagerTitleGuard.test.ts
git commit -m "feat(downloadManager): refuse cross-title torrent reuse

Task: SourceDownload Phase 6 - Title guard"
```

---

## Phase 7: Drop legacy columns (Migration B)

Run ONLY after Phase 4 has been deployed with `ANNEX_FILE_MAPPING_V2=true` in production for at least one full request cycle, and the shadow-mode comparison has produced no disagreements.

### Task 17: Migration B — drop `ProcessingItem.sourceFilePath`

**Files:**
- Modify: `packages/server/prisma/schema.prisma`
- Create: `packages/server/prisma/migrations/<timestamp>_drop_source_file_path/migration.sql`

- [ ] **Step 1: Edit schema — remove `sourceFilePath` from `ProcessingItem`**

In `schema.prisma`, find the `ProcessingItem` model and delete the line:

```prisma
  sourceFilePath  String?
```

- [ ] **Step 2: Generate the migration**

Run: `cd packages/server && bunx prisma migrate dev --name drop_source_file_path --create-only`
Expected: a new migration directory with `ALTER TABLE "ProcessingItem" DROP COLUMN "sourceFilePath"`.

- [ ] **Step 3: Remove all remaining `sourceFilePath` reads from the codebase**

Run: `grep -rn "sourceFilePath" packages/server/src/`

For each hit:
- If it's a write to `processingItem.sourceFilePath`, delete the line.
- If it's a read from `processingItem.sourceFilePath`, replace with `(await resolveSourceFilePath(item))`.
- Do NOT touch the `Download.contentPath` or `stepContext.download.sourceFilePath` paths (those are still legitimate for movies; we drop those in a future cleanup).

- [ ] **Step 4: Apply migration**

Run: `cd packages/server && bunx prisma migrate dev`

- [ ] **Step 5: Run the full test suite**

Run: `cd packages/server && bun test`
Expected: all tests pass.

- [ ] **Step 6: Typecheck**

Run: `cd packages/server && bunx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add packages/server/prisma/schema.prisma packages/server/prisma/migrations packages/server/src
git commit -m "refactor(schema): drop ProcessingItem.sourceFilePath

Task: SourceDownload Phase 7 - Migration B"
```

---

## Phase 8: Operational rollout

### Task 18: Enable feature flag in staging, watch shadow logs

**Files:** none (operational task)

- [ ] **Step 1: Deploy code with `ANNEX_FILE_MAPPING_V2` unset**

Both legacy and shadow paths run.

- [ ] **Step 2: After 24h, grep server logs for `Shadow mapping failed`**

If any failures, file issues and fix before continuing.

- [ ] **Step 3: Set `ANNEX_FILE_MAPPING_V2=true` in staging env**

Restart server. Run a TV season-pack request end-to-end. Verify:
- `Download.fileMapStatus` walks `PENDING → MAPPING → MAPPED`.
- `DownloadFile` rows exist with `processingItemId` linked.
- Encoded files appear with item-specific names.
- Delivery succeeds.

- [ ] **Step 4: Watch encoding/delivery for 7 days at high concurrency**

Verify no "same file, multiple titles" events. Track via:

```sql
SELECT df.absolute_path, COUNT(DISTINCT pi.title) AS distinct_titles
FROM "DownloadFile" df
JOIN "ProcessingItem" pi ON pi.id = df.processing_item_id
GROUP BY df.absolute_path
HAVING COUNT(DISTINCT pi.title) > 1;
```

Expected: empty result.

- [ ] **Step 5: Roll to production**

Set `ANNEX_FILE_MAPPING_V2=true` in prod, deploy, monitor.

### Task 19: Drop legacy code paths

**Files:**
- Modify: `packages/server/src/services/pipeline/steps/DownloadStep.ts`

- [ ] **Step 1: Delete `extractEpisodeFiles` legacy body**

Remove the original regex-driven implementation (lines previously 728-869 before the flag check). Keep only the v2 path. Inline `extractEpisodeFilesV2` into `extractEpisodeFiles` and remove the v2 method name.

- [ ] **Step 2: Delete the feature flag**

Remove `fileMappingV2Enabled` calls. Delete `packages/server/src/services/fileMapping/featureFlag.ts` and its test. Delete the import.

- [ ] **Step 3: Run tests + typecheck**

Run: `cd packages/server && bun test && bunx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add packages/server/src packages/server/src/__tests__
git commit -m "chore(fileMapping): drop legacy regex path and feature flag

Task: SourceDownload Phase 8 - Final cleanup"
```

---

## Open questions deferred from spec

These are NOT in this plan. They need their own brainstorm/plan before implementation:

- **Multi-episode delivery splitting.** When one `DownloadFile` covers `S01E01E02`, do we deliver as one file or two? Today the matcher assigns the same `DownloadFile` to multiple PIs; downstream encode/deliver assumes 1:1. This must be designed before any multi-episode file is encountered in production.
- **Anime / absolute numbering.** Out of scope for v1. Marks anime requests as `mapping_miss` until a TMDB episode-order resolution step is added.
- **Cross-request UI.** "This download is also serving request B" surface in the UI.

---

## Validation checkpoints

After every phase:

```bash
cd /Users/bryan/Development/Annex
bun run lint
bun run typecheck
bun run build
bun test
```

All four MUST pass before moving to the next phase.

---

## File summary

**New files:**
- `packages/server/scripts/backfill-download-files.ts`
- `packages/server/src/services/fileMapping/index.ts`
- `packages/server/src/services/fileMapping/types.ts`
- `packages/server/src/services/fileMapping/featureFlag.ts`
- `packages/server/src/services/fileMapping/matcher.ts`
- `packages/server/src/services/fileMapping/classifiers/index.ts`
- `packages/server/src/services/fileMapping/parsers/seasonEpisode.ts`
- `packages/server/src/services/fileMapping/parsers/multiEpisode.ts`
- `packages/server/src/services/fileMapping/parsers/dailyAir.ts`
- `packages/server/src/services/pipeline/workers/FileMapWorker.ts`
- `packages/server/prisma/migrations/<ts>_add_download_file/migration.sql`
- `packages/server/prisma/migrations/<ts>_drop_source_file_path/migration.sql`
- Tests under `packages/server/src/__tests__/services/fileMapping/`, `__tests__/services/pipeline/workers/`, `__tests__/services/pipeline/steps/`, `__tests__/scripts/`, `__tests__/services/downloadManagerTitleGuard.test.ts`

**Modified files:**
- `packages/server/prisma/schema.prisma`
- `packages/server/src/index.ts`
- `packages/server/src/services/pipeline/steps/DownloadStep.ts`
- `packages/server/src/services/pipeline/workers/EncodeWorker.ts`
- `packages/server/src/services/downloadManager.ts`
