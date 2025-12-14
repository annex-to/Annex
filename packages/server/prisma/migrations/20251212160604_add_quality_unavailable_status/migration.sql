-- AlterEnum
ALTER TYPE "RequestStatus" ADD VALUE 'QUALITY_UNAVAILABLE';

-- AlterEnum
ALTER TYPE "TvEpisodeStatus" ADD VALUE 'QUALITY_UNAVAILABLE';

-- AlterTable
ALTER TABLE "MediaRequest" ADD COLUMN     "availableReleases" JSONB,
ADD COLUMN     "qualitySearchedAt" TIMESTAMP(3),
ADD COLUMN     "requiredResolution" TEXT;

-- AlterTable
ALTER TABLE "TvEpisode" ADD COLUMN     "availableReleases" JSONB,
ADD COLUMN     "qualityMet" BOOLEAN NOT NULL DEFAULT false;
