-- AlterTable
ALTER TABLE "ProcessingItem" ADD COLUMN     "checkpoint" JSONB,
ADD COLUMN     "errorHistory" JSONB,
ADD COLUMN     "lastProgressUpdate" TIMESTAMP(3),
ADD COLUMN     "lastProgressValue" INTEGER,
ADD COLUMN     "skipUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CircuitBreaker" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CLOSED',
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastFailure" TIMESTAMP(3),
    "opensAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircuitBreaker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CircuitBreaker_service_key" ON "CircuitBreaker"("service");

-- CreateIndex
CREATE INDEX "CircuitBreaker_service_idx" ON "CircuitBreaker"("service");

-- CreateIndex
CREATE INDEX "CircuitBreaker_state_idx" ON "CircuitBreaker"("state");
