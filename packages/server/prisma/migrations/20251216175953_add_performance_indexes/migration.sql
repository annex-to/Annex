-- CreateIndex
CREATE INDEX "EncodingProfile_isDefault_idx" ON "EncodingProfile"("isDefault");

-- CreateIndex
CREATE INDEX "EpisodeLibraryItem_serverId_idx" ON "EpisodeLibraryItem"("serverId");

-- CreateIndex
CREATE INDEX "Indexer_enabled_priority_idx" ON "Indexer"("enabled", "priority");

-- CreateIndex
CREATE INDEX "Indexer_type_enabled_idx" ON "Indexer"("type", "enabled");

-- CreateIndex
CREATE INDEX "LibraryItem_serverId_idx" ON "LibraryItem"("serverId");

-- CreateIndex
CREATE INDEX "LibraryItem_serverId_type_idx" ON "LibraryItem"("serverId", "type");

-- CreateIndex
CREATE INDEX "MediaRequest_status_idx" ON "MediaRequest"("status");

-- CreateIndex
CREATE INDEX "MediaRequest_createdAt_idx" ON "MediaRequest"("createdAt");

-- CreateIndex
CREATE INDEX "MediaRequest_status_createdAt_idx" ON "MediaRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "StorageServer_enabled_idx" ON "StorageServer"("enabled");
