-- AlterEnum
ALTER TYPE "EpisodeDownloadStatus" ADD VALUE 'AVAILABLE';

-- CreateTable
CREATE TABLE "EpisodeLibraryItem" (
    "id" TEXT NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "season" INTEGER NOT NULL,
    "episode" INTEGER NOT NULL,
    "quality" TEXT,
    "addedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "serverId" TEXT NOT NULL,

    CONSTRAINT "EpisodeLibraryItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EpisodeLibraryItem_tmdbId_serverId_idx" ON "EpisodeLibraryItem"("tmdbId", "serverId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeLibraryItem_tmdbId_season_episode_serverId_key" ON "EpisodeLibraryItem"("tmdbId", "season", "episode", "serverId");

-- AddForeignKey
ALTER TABLE "EpisodeLibraryItem" ADD CONSTRAINT "EpisodeLibraryItem_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "StorageServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
