-- CreateEnum
CREATE TYPE "EpisodeDownloadStatus" AS ENUM ('PENDING', 'AWAITING', 'SEARCHING', 'DOWNLOADING', 'ENCODING', 'DELIVERING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "MediaRequest" ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "monitoring" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EpisodeStatus" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "episode" INTEGER NOT NULL,
    "status" "EpisodeDownloadStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "selectedRelease" JSONB,
    "torrentHash" TEXT,
    "sourceFilePath" TEXT,
    "isSeasonPack" BOOLEAN NOT NULL DEFAULT false,
    "airDate" TIMESTAMP(3),
    "downloadedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EpisodeStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EpisodeStatus_requestId_status_idx" ON "EpisodeStatus"("requestId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeStatus_requestId_season_episode_key" ON "EpisodeStatus"("requestId", "season", "episode");

-- CreateIndex
CREATE INDEX "MediaRequest_monitoring_type_idx" ON "MediaRequest"("monitoring", "type");

-- AddForeignKey
ALTER TABLE "EpisodeStatus" ADD CONSTRAINT "EpisodeStatus_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
