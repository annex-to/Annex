-- AlterTable
ALTER TABLE "MediaRequest" ADD COLUMN     "releaseCodec" TEXT,
ADD COLUMN     "releaseFileSize" BIGINT,
ADD COLUMN     "releaseIndexerName" TEXT,
ADD COLUMN     "releaseLeechers" INTEGER,
ADD COLUMN     "releaseName" TEXT,
ADD COLUMN     "releasePublishDate" TIMESTAMP(3),
ADD COLUMN     "releaseResolution" TEXT,
ADD COLUMN     "releaseScore" INTEGER,
ADD COLUMN     "releaseSeeders" INTEGER,
ADD COLUMN     "releaseSource" TEXT;
