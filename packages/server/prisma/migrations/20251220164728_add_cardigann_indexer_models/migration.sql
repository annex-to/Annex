-- CreateTable
CREATE TABLE "CardigannIndexer" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "categoriesMovies" INTEGER[],
    "categoriesTv" INTEGER[],
    "priority" INTEGER NOT NULL DEFAULT 50,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rateLimitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rateLimitMax" INTEGER,
    "rateLimitWindowSecs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardigannIndexer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardigannIndexerRateLimitRequest" (
    "id" TEXT NOT NULL,
    "indexerId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardigannIndexerRateLimitRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CardigannIndexer_enabled_priority_idx" ON "CardigannIndexer"("enabled", "priority");

-- CreateIndex
CREATE INDEX "CardigannIndexer_definitionId_idx" ON "CardigannIndexer"("definitionId");

-- CreateIndex
CREATE INDEX "CardigannIndexer_definitionId_enabled_idx" ON "CardigannIndexer"("definitionId", "enabled");

-- CreateIndex
CREATE INDEX "CardigannIndexerRateLimitRequest_indexerId_requestedAt_idx" ON "CardigannIndexerRateLimitRequest"("indexerId", "requestedAt");

-- CreateIndex
CREATE INDEX "CardigannIndexerRateLimitRequest_requestedAt_idx" ON "CardigannIndexerRateLimitRequest"("requestedAt");

-- AddForeignKey
ALTER TABLE "CardigannIndexerRateLimitRequest" ADD CONSTRAINT "CardigannIndexerRateLimitRequest_indexerId_fkey" FOREIGN KEY ("indexerId") REFERENCES "CardigannIndexer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
