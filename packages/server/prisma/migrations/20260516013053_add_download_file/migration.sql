-- CreateEnum
CREATE TYPE "DownloadFileKind" AS ENUM ('VIDEO_MAIN', 'VIDEO_SAMPLE', 'SUBTITLE', 'EXTRA', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DownloadFileMapStatus" AS ENUM ('PENDING', 'MAPPING', 'MAPPED', 'FAILED');

-- AlterTable
ALTER TABLE "Download" ADD COLUMN "fileMapStatus" "DownloadFileMapStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Download" ADD COLUMN "mapAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DownloadFile" (
    "id" TEXT NOT NULL,
    "downloadId" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "absolutePath" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "fileHash" TEXT,
    "kind" "DownloadFileKind" NOT NULL DEFAULT 'UNKNOWN',
    "season" INTEGER,
    "episode" INTEGER,
    "episodeEnd" INTEGER,
    "airDate" TIMESTAMP(3),
    "absoluteNumber" INTEGER,
    "parserVersion" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "rejected" BOOLEAN NOT NULL DEFAULT false,
    "rejectReason" TEXT,
    "processingItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownloadFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DownloadFile_processingItemId_key" ON "DownloadFile"("processingItemId");

-- CreateIndex
CREATE UNIQUE INDEX "DownloadFile_downloadId_relativePath_key" ON "DownloadFile"("downloadId", "relativePath");

-- CreateIndex
CREATE INDEX "DownloadFile_downloadId_kind_idx" ON "DownloadFile"("downloadId", "kind");

-- CreateIndex
CREATE INDEX "DownloadFile_processingItemId_idx" ON "DownloadFile"("processingItemId");

-- AddForeignKey
ALTER TABLE "DownloadFile" ADD CONSTRAINT "DownloadFile_downloadId_fkey" FOREIGN KEY ("downloadId") REFERENCES "Download"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadFile" ADD CONSTRAINT "DownloadFile_processingItemId_fkey" FOREIGN KEY ("processingItemId") REFERENCES "ProcessingItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
