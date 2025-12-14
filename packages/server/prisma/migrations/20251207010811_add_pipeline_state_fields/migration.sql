-- AlterTable
ALTER TABLE "MediaRequest" ADD COLUMN     "encodedFiles" JSONB,
ADD COLUMN     "selectedRelease" JSONB,
ADD COLUMN     "sourceFilePath" TEXT,
ADD COLUMN     "torrentHash" TEXT;
