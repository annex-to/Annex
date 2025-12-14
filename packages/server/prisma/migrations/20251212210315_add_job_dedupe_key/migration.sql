-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "dedupeKey" TEXT;

-- CreateIndex
CREATE INDEX "Job_dedupeKey_status_idx" ON "Job"("dedupeKey", "status");
