-- CreateEnum
CREATE TYPE "DownloadStatus" AS ENUM ('PENDING', 'DOWNLOADING', 'COMPLETED', 'IMPORTING', 'PROCESSED', 'CLEANED', 'FAILED', 'CANCELLED', 'STALLED');

-- CreateEnum
CREATE TYPE "TvEpisodeStatus" AS ENUM ('PENDING', 'AWAITING', 'SEARCHING', 'DOWNLOADING', 'DOWNLOADED', 'ENCODING', 'ENCODED', 'DELIVERING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- DropForeignKey
ALTER TABLE "EpisodeStatus" DROP CONSTRAINT "EpisodeStatus_requestId_fkey";

-- DropTable
DROP TABLE "EpisodeStatus";

-- DropEnum
DROP TYPE "EpisodeDownloadStatus";

-- CreateTable
CREATE TABLE "Download" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "torrentHash" TEXT NOT NULL,
    "torrentName" TEXT NOT NULL,
    "magnetUri" TEXT,
    "savePath" TEXT,
    "contentPath" TEXT,
    "status" "DownloadStatus" NOT NULL DEFAULT 'PENDING',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "size" BIGINT,
    "error" TEXT,
    "failureReason" TEXT,
    "mediaType" "MediaType" NOT NULL,
    "isSeasonPack" BOOLEAN NOT NULL DEFAULT false,
    "season" INTEGER,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "lastAttemptAt" TIMESTAMP(3),
    "alternativeReleases" JSONB,
    "lastProgressAt" TIMESTAMP(3),
    "seedCount" INTEGER,
    "peerCount" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Download_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownloadEvent" (
    "id" TEXT NOT NULL,
    "downloadId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DownloadEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TvEpisode" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "episode" INTEGER NOT NULL,
    "title" TEXT,
    "airDate" TIMESTAMP(3),
    "downloadId" TEXT,
    "sourceFilePath" TEXT,
    "status" "TvEpisodeStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "downloadedAt" TIMESTAMP(3),
    "encodedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TvEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "preferredResolutions" TEXT[],
    "minResolution" TEXT NOT NULL DEFAULT '720p',
    "preferredSources" TEXT[],
    "preferredCodecs" TEXT[],
    "minSizeGB" DOUBLE PRECISION,
    "maxSizeGB" DOUBLE PRECISION,
    "preferredGroups" TEXT[],
    "bannedGroups" TEXT[],
    "allowUpgrades" BOOLEAN NOT NULL DEFAULT true,
    "upgradeUntilResolution" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QualityProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BadRelease" (
    "id" TEXT NOT NULL,
    "torrentHash" TEXT,
    "title" TEXT,
    "indexer" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BadRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Download_torrentHash_key" ON "Download"("torrentHash");

-- CreateIndex
CREATE INDEX "Download_requestId_idx" ON "Download"("requestId");

-- CreateIndex
CREATE INDEX "Download_status_idx" ON "Download"("status");

-- CreateIndex
CREATE INDEX "Download_mediaType_status_idx" ON "Download"("mediaType", "status");

-- CreateIndex
CREATE INDEX "DownloadEvent_downloadId_idx" ON "DownloadEvent"("downloadId");

-- CreateIndex
CREATE INDEX "DownloadEvent_event_createdAt_idx" ON "DownloadEvent"("event", "createdAt");

-- CreateIndex
CREATE INDEX "TvEpisode_requestId_status_idx" ON "TvEpisode"("requestId", "status");

-- CreateIndex
CREATE INDEX "TvEpisode_downloadId_idx" ON "TvEpisode"("downloadId");

-- CreateIndex
CREATE UNIQUE INDEX "TvEpisode_requestId_season_episode_key" ON "TvEpisode"("requestId", "season", "episode");

-- CreateIndex
CREATE UNIQUE INDEX "QualityProfile_name_key" ON "QualityProfile"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BadRelease_torrentHash_key" ON "BadRelease"("torrentHash");

-- CreateIndex
CREATE INDEX "BadRelease_title_idx" ON "BadRelease"("title");

-- AddForeignKey
ALTER TABLE "Download" ADD CONSTRAINT "Download_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadEvent" ADD CONSTRAINT "DownloadEvent_downloadId_fkey" FOREIGN KEY ("downloadId") REFERENCES "Download"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TvEpisode" ADD CONSTRAINT "TvEpisode_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TvEpisode" ADD CONSTRAINT "TvEpisode_downloadId_fkey" FOREIGN KEY ("downloadId") REFERENCES "Download"("id") ON DELETE SET NULL ON UPDATE CASCADE;

