-- AlterTable
ALTER TABLE "MediaRatings" ADD COLUMN     "aggregatedAt" TIMESTAMP(3),
ADD COLUMN     "confidenceScore" DOUBLE PRECISION,
ADD COLUMN     "isTrusted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceCount" INTEGER;

-- CreateIndex
CREATE INDEX "MediaRatings_isTrusted_aggregateScore_idx" ON "MediaRatings"("isTrusted", "aggregateScore");

-- CreateIndex
CREATE INDEX "MediaRatings_sourceCount_idx" ON "MediaRatings"("sourceCount");
