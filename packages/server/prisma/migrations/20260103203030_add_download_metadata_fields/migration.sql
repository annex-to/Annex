/*
  Warnings:

  - You are about to drop the `TvEpisode` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "PipelineExecution" DROP CONSTRAINT "PipelineExecution_parentExecutionId_fkey";

-- DropForeignKey
ALTER TABLE "TvEpisode" DROP CONSTRAINT "TvEpisode_downloadId_fkey";

-- DropForeignKey
ALTER TABLE "TvEpisode" DROP CONSTRAINT "TvEpisode_requestId_fkey";

-- DropIndex
DROP INDEX "PipelineExecution_requestId_key";

-- AlterTable
ALTER TABLE "Download" ADD COLUMN     "codec" TEXT,
ADD COLUMN     "indexerName" TEXT,
ADD COLUMN     "publishDate" TIMESTAMP(3),
ADD COLUMN     "qualityScore" INTEGER,
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "source" TEXT;

-- DropTable
DROP TABLE "TvEpisode";

-- DropEnum
DROP TYPE "TvEpisodeStatus";

-- CreateTable
CREATE TABLE "RequestTarget" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "encodingProfileId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestedEpisode" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "episode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestedEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlternativeRelease" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "processingItemId" TEXT,
    "title" TEXT NOT NULL,
    "indexerId" TEXT NOT NULL,
    "indexerName" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "codec" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "seeders" INTEGER NOT NULL,
    "leechers" INTEGER NOT NULL,
    "magnetUri" TEXT,
    "downloadUrl" TEXT,
    "infoUrl" TEXT,
    "publishDate" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlternativeRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequestTarget_requestId_idx" ON "RequestTarget"("requestId");

-- CreateIndex
CREATE INDEX "RequestTarget_serverId_idx" ON "RequestTarget"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "RequestTarget_requestId_serverId_key" ON "RequestTarget"("requestId", "serverId");

-- CreateIndex
CREATE INDEX "RequestedEpisode_requestId_idx" ON "RequestedEpisode"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "RequestedEpisode_requestId_season_episode_key" ON "RequestedEpisode"("requestId", "season", "episode");

-- CreateIndex
CREATE INDEX "AlternativeRelease_requestId_idx" ON "AlternativeRelease"("requestId");

-- CreateIndex
CREATE INDEX "AlternativeRelease_processingItemId_idx" ON "AlternativeRelease"("processingItemId");

-- CreateIndex
CREATE INDEX "AlternativeRelease_requestId_rank_idx" ON "AlternativeRelease"("requestId", "rank");

-- CreateIndex
CREATE INDEX "AlternativeRelease_processingItemId_rank_idx" ON "AlternativeRelease"("processingItemId", "rank");

-- AddForeignKey
ALTER TABLE "RequestTarget" ADD CONSTRAINT "RequestTarget_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestedEpisode" ADD CONSTRAINT "RequestedEpisode_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlternativeRelease" ADD CONSTRAINT "AlternativeRelease_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlternativeRelease" ADD CONSTRAINT "AlternativeRelease_processingItemId_fkey" FOREIGN KEY ("processingItemId") REFERENCES "ProcessingItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineExecution" ADD CONSTRAINT "PipelineExecution_parentExecutionId_fkey" FOREIGN KEY ("parentExecutionId") REFERENCES "PipelineExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
