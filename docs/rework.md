# Request Pipeline System Rework

Complete redesign of the worker system to eliminate stuck items, improve reliability, and make the system bulletproof.

## Current Problems

### 1. While Loops in Workers
**Problem**: DownloadWorker transitions items to DOWNLOADING, then polls qBittorrent in a while loop waiting for completion.

**Impact**:
- If server crashes/restarts, the while loop exits
- Item stuck in DOWNLOADING forever
- Need DownloadRecoveryWorker to clean up the mess

**Example**:
```typescript
// DownloadWorker.ts line 319
while (Date.now() - startTime < maxWaitTime) {
  const torrent = await qb.getProgress(torrentHash);
  // ... poll and wait
}
```

### 2. Split Responsibilities
**Problem**: Multiple workers handling the same lifecycle:
- DownloadWorker: Creates downloads, monitors with while loop
- DownloadProgressWorker: Syncs progress, refuses to transition
- DownloadRecoveryWorker: Fixes stuck items

**Impact**:
- Race conditions between workers
- "Avoid race conditions" comments preventing proper transitions
- Recovery workers are band-aids

**Example**:
```typescript
// DownloadProgressWorker.ts line 58
// Skip if already at 100% - StuckItemRecoveryWorker will handle transition
if (item.progress >= 100 && torrentProgress.progress >= 100) {
  return;
}
```

### 3. Arbitrary Timeout-Based Recovery
**Problem**: StuckItemRecoveryWorker checks if items haven't updated in X minutes.

**Impact**:
- Items at 99% progress are "stuck" after 10 minutes
- Items at 0% progress with active work are "stuck" too
- No distinction between stalled and slow

**Example**: Item encoding a large file slowly is marked as stuck and failed.

### 4. Broken Retry Logic
**Problem**: Items reach maxAttempts but don't transition to FAILED.

**Impact**:
- Items retry forever
- Trap House stuck in DELIVERING for over an hour with 5 attempts

### 5. No Graceful Degradation
**Problem**: If a service is down (indexer, encoder, storage server), requests fail immediately.

**Impact**:
- TorrentLeech down? All TV requests fail
- Should skip and retry later when service recovers

### 6. No Checkpointing
**Problem**: If delivery fails on 4th of 5 servers, retry starts from scratch.

**Impact**:
- Re-uploads to servers 1-3
- Wastes bandwidth and time
- Higher chance of failure

---

## New Architecture

### Core Principles

1. **Single Responsibility** - One worker handles full lifecycle of its status(es)
2. **No Blocking** - No while loops, everything scheduled
3. **Stateless Workers** - All state in database, workers can crash/restart anytime
4. **Idempotent** - Running worker twice on same item is safe
5. **Progress-Based Health** - Detect stalls by comparing progress over time
6. **Graceful Degradation** - Service down? Skip and retry later
7. **Checkpointing** - Resume from where we left off

### Worker Model

Each worker:
- Scheduled to run every 5 seconds
- Processes **ALL** items in its status(es)
- Handles both new work and monitoring existing work
- Transitions items when complete
- No separate monitor or recovery workers needed

```
Worker Schedule (every 5s):
┌─────────────────────────────────────────┐
│ SearchWorker                            │
│ - Process PENDING items                 │
│ - Search indexers                       │
│ - Transition to FOUND                   │
└─────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────┐
│ DownloadWorker                          │
│ - Start downloads (FOUND → DOWNLOADING) │
│ - Monitor downloads (update progress)   │
│ - Transition when complete (DOWNLOADED) │
└─────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────┐
│ EncodeWorker                            │
│ - Queue jobs (DOWNLOADED → ENCODING)    │
│ - Monitor jobs (update progress)        │
│ - Transition when complete (ENCODED)    │
└─────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────┐
│ DeliverWorker                           │
│ - Start delivery (ENCODED → DELIVERING) │
│ - Deliver with checkpoints              │
│ - Transition when complete (COMPLETED)  │
└─────────────────────────────────────────┘
```

---

## Database Schema Changes

### ProcessingItem Enhancements

```prisma
model ProcessingItem {
  // ... existing fields

  // Progress tracking
  progress Int @default(0)
  lastProgressUpdate DateTime?
  lastProgressValue Int? // For stall detection

  // Smart retry
  attempts Int @default(0)
  maxAttempts Int @default(5)
  nextRetryAt DateTime? // Exponential backoff retry
  skipUntil DateTime? // Service outage, not item's fault

  // Checkpointing
  checkpoint Json? // Resume partial work

  // Error tracking
  lastError String?
  errorHistory Json? // Array of timestamped errors

  // ... rest of fields
}
```

**Key additions**:
- `lastProgressValue`: Compare to current progress for stall detection
- `lastProgressUpdate`: When progress last changed
- `skipUntil`: Temporary skip due to service outage (doesn't count as attempt)
- `checkpoint`: Resume partial work (e.g., delivered servers)
- `errorHistory`: Track all errors for debugging

### Circuit Breaker Table

```prisma
model CircuitBreaker {
  id String @id @default(cuid())
  service String @unique // "indexer:torrentleech", "encoder:enc-01", "server:plex-01"
  state String // CLOSED, OPEN, HALF_OPEN
  failures Int @default(0)
  lastFailure DateTime?
  opensAt DateTime? // When to attempt half-open
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

**Purpose**: Track service health, stop hammering dead services.

---

## Worker Redesigns

### DownloadWorker

**Status**: Processes `FOUND` and `DOWNLOADING`

**Responsibilities**:
1. Create downloads for FOUND items → DOWNLOADING
2. Monitor DOWNLOADING items, update progress
3. Detect stalled downloads (no progress change for 30 min)
4. Transition to DOWNLOADED when complete

**Implementation**:
```typescript
export class DownloadWorker extends BaseWorker {
  readonly processingStatus = "FOUND" as const;
  readonly nextStatus = "DOWNLOADED" as const;
  readonly name = "DownloadWorker";
  readonly concurrency = 10;

  async processBatch(): Promise<void> {
    await this.startNewDownloads();
    await this.monitorActiveDownloads();
  }

  private async startNewDownloads(): Promise<void> {
    const foundItems = await pipelineOrchestrator.getItemsForProcessing("FOUND");

    for (const item of foundItems.slice(0, this.concurrency)) {
      try {
        await this.createDownload(item);
      } catch (error) {
        await this.handleError(item, error);
      }
    }
  }

  private async monitorActiveDownloads(): Promise<void> {
    const downloadingItems = await pipelineOrchestrator.getItemsForProcessing("DOWNLOADING");

    for (const item of downloadingItems) {
      try {
        await this.checkDownloadProgress(item);
      } catch (error) {
        await this.handleError(item, error);
      }
    }
  }

  private async createDownload(item: ProcessingItem): Promise<void> {
    // Get search results
    const searchData = item.stepContext.search;
    const release = searchData.selectedRelease;

    // Add to qBittorrent
    const download = await downloadManager.createDownload(release);

    // Transition to DOWNLOADING with downloadId
    await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADING", {
      downloadId: download.id,
      lastProgressUpdate: new Date(),
      lastProgressValue: 0,
    });
  }

  private async checkDownloadProgress(item: ProcessingItem): Promise<void> {
    const download = await prisma.download.findUnique({
      where: { id: item.downloadId }
    });

    const qb = getDownloadService();
    const torrent = await qb.getProgress(download.torrentHash);

    // Stall detection: Compare progress to last known value
    const progressChanged = torrent.progress !== item.lastProgressValue;

    if (!progressChanged && item.lastProgressUpdate) {
      const stallTime = Date.now() - item.lastProgressUpdate.getTime();

      if (stallTime > 30 * 60 * 1000) { // 30 minutes
        console.warn(`[${this.name}] Download stalled for ${item.title}`);

        // Check if torrent is actually stalled in qBittorrent
        if (torrent.state === "stalledDL" || torrent.state === "error") {
          throw new Error(`Download stalled: ${torrent.state}`);
        }
      }
    }

    // Update progress if changed
    if (progressChanged) {
      await pipelineOrchestrator.updateProgress(item.id, torrent.progress, {
        lastProgressUpdate: new Date(),
        lastProgressValue: torrent.progress,
      });
    }

    // Transition when complete
    if (torrent.isComplete || torrent.progress >= 100) {
      const filePath = await this.findVideoFile(torrent.contentPath, item);

      await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADED", {
        stepContext: {
          ...item.stepContext,
          download: {
            torrentHash: download.torrentHash,
            sourceFilePath: filePath,
          }
        }
      });

      console.log(`[${this.name}] Download complete: ${item.title}`);
    }
  }

  private async handleError(item: ProcessingItem, error: Error): Promise<void> {
    console.error(`[${this.name}] Error processing ${item.title}:`, error);
    await pipelineOrchestrator.handleError(item.id, error);
  }
}
```

**Key changes**:
- No while loops - just check status on each tick
- Stall detection compares progress values
- Single worker handles both starting and monitoring
- Clean error handling

### EncodeWorker

**Status**: Processes `DOWNLOADED` and `ENCODING`

**Responsibilities**:
1. Queue encoding jobs for DOWNLOADED items → ENCODING
2. Monitor ENCODING items, update progress
3. Detect stalled encoding (no progress for 10 min)
4. Transition to ENCODED when complete

**Implementation**:
```typescript
export class EncodeWorker extends BaseWorker {
  readonly processingStatus = "DOWNLOADED" as const;
  readonly nextStatus = "ENCODED" as const;
  readonly name = "EncodeWorker";
  readonly concurrency = 5;

  async processBatch(): Promise<void> {
    await this.startNewEncodingJobs();
    await this.monitorActiveJobs();
  }

  private async startNewEncodingJobs(): Promise<void> {
    const downloadedItems = await pipelineOrchestrator.getItemsForProcessing("DOWNLOADED");

    for (const item of downloadedItems.slice(0, this.concurrency)) {
      try {
        // Check if we have available encoders
        const hasEncoders = await encoderDispatch.hasAvailableEncoders();

        if (!hasEncoders) {
          // No encoders available - skip until they come online
          await prisma.processingItem.update({
            where: { id: item.id },
            data: { skipUntil: new Date(Date.now() + 5 * 60 * 1000) }
          });
          continue;
        }

        // Create encoding job
        const job = await this.createEncodingJob(item);

        // Transition to ENCODING
        await pipelineOrchestrator.transitionStatus(item.id, "ENCODING", {
          encodingJobId: job.id,
          lastProgressUpdate: new Date(),
          lastProgressValue: 0,
        });

      } catch (error) {
        await this.handleError(item, error);
      }
    }
  }

  private async monitorActiveJobs(): Promise<void> {
    const encodingItems = await pipelineOrchestrator.getItemsForProcessing("ENCODING");

    for (const item of encodingItems) {
      try {
        await this.checkEncodingProgress(item);
      } catch (error) {
        await this.handleError(item, error);
      }
    }
  }

  private async checkEncodingProgress(item: ProcessingItem): Promise<void> {
    const assignment = await prisma.encoderAssignment.findFirst({
      where: { jobId: item.encodingJobId },
      include: { job: true }
    });

    if (!assignment) {
      throw new Error("No encoder assignment found");
    }

    // Stall detection: Compare progress to last known value
    const progressChanged = assignment.progress !== item.lastProgressValue;

    if (!progressChanged && item.lastProgressUpdate) {
      const stallTime = Date.now() - item.lastProgressUpdate.getTime();

      if (stallTime > 10 * 60 * 1000) { // 10 minutes
        console.warn(`[${this.name}] Encoding stalled for ${item.title}`);

        // Cancel stalled job and retry
        await encoderDispatch.cancelAssignment(assignment.id);

        // Transition back to DOWNLOADED to retry
        await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADED", {
          lastError: "Encoding stalled - retrying with different encoder"
        });

        return;
      }
    }

    // Update progress if changed
    if (progressChanged) {
      await pipelineOrchestrator.updateProgress(item.id, assignment.progress, {
        lastProgressUpdate: new Date(),
        lastProgressValue: assignment.progress,
      });
    }

    // Check completion
    if (assignment.status === "COMPLETED") {
      await pipelineOrchestrator.transitionStatus(item.id, "ENCODED", {
        stepContext: {
          ...item.stepContext,
          encode: {
            outputPath: assignment.outputPath,
            encoderId: assignment.encoderId,
          }
        }
      });

      console.log(`[${this.name}] Encoding complete: ${item.title}`);
    } else if (assignment.status === "FAILED") {
      throw new Error(assignment.error || "Encoding failed");
    }
  }

  private async handleError(item: ProcessingItem, error: Error): Promise<void> {
    console.error(`[${this.name}] Error processing ${item.title}:`, error);
    await pipelineOrchestrator.handleError(item.id, error);
  }
}
```

### DeliverWorker

**Status**: Processes `ENCODED` and `DELIVERING`

**Responsibilities**:
1. Start delivery for ENCODED items → DELIVERING
2. Deliver to servers with checkpointing
3. Resume partial deliveries from checkpoint
4. Transition to COMPLETED when all servers delivered

**Implementation**:
```typescript
export class DeliverWorker extends BaseWorker {
  readonly processingStatus = "ENCODED" as const;
  readonly nextStatus = "COMPLETED" as const;
  readonly name = "DeliverWorker";
  readonly concurrency = 2; // Delivery is intensive

  async processBatch(): Promise<void> {
    await this.startNewDeliveries();
    await this.continueActiveDeliveries();
  }

  private async startNewDeliveries(): Promise<void> {
    const encodedItems = await pipelineOrchestrator.getItemsForProcessing("ENCODED");

    for (const item of encodedItems.slice(0, this.concurrency)) {
      try {
        // Transition to DELIVERING with empty checkpoint
        await pipelineOrchestrator.transitionStatus(item.id, "DELIVERING", {
          checkpoint: { deliveredServers: [] },
          lastProgressUpdate: new Date(),
        });
      } catch (error) {
        await this.handleError(item, error);
      }
    }
  }

  private async continueActiveDeliveries(): Promise<void> {
    const deliveringItems = await pipelineOrchestrator.getItemsForProcessing("DELIVERING");

    for (const item of deliveringItems) {
      try {
        await this.deliverToServers(item);
      } catch (error) {
        await this.handleError(item, error);
      }
    }
  }

  private async deliverToServers(item: ProcessingItem): Promise<void> {
    const encodeData = item.stepContext.encode;
    const outputPath = encodeData.outputPath;

    // Get checkpoint
    const checkpoint = item.checkpoint || { deliveredServers: [] };
    const deliveredServers = checkpoint.deliveredServers as string[];

    // Get target servers
    const request = await prisma.mediaRequest.findUnique({
      where: { id: item.requestId }
    });
    const targets = request.targets as Array<{ serverId: string }>;

    // Deliver to each server not yet completed
    for (const target of targets) {
      if (deliveredServers.includes(target.serverId)) {
        console.log(`[${this.name}] Skipping already delivered server: ${target.serverId}`);
        continue;
      }

      try {
        // Check circuit breaker
        const isHealthy = await circuitBreaker.isHealthy(`server:${target.serverId}`);

        if (!isHealthy) {
          console.warn(`[${this.name}] Server ${target.serverId} circuit open, skipping`);
          continue;
        }

        // Deliver to this server
        await this.deliverToServer(item, target.serverId, outputPath);

        // Update checkpoint
        deliveredServers.push(target.serverId);
        await prisma.processingItem.update({
          where: { id: item.id },
          data: {
            checkpoint: { deliveredServers },
            lastProgressUpdate: new Date(),
          }
        });

        console.log(`[${this.name}] Delivered to ${target.serverId}: ${item.title}`);

      } catch (error) {
        console.error(`[${this.name}] Failed to deliver to ${target.serverId}:`, error);

        // Record failure for circuit breaker
        await circuitBreaker.recordFailure(`server:${target.serverId}`, error);

        // If this is a permanent error for this server, mark it as failed
        if (this.isPermanentDeliveryError(error)) {
          deliveredServers.push(target.serverId); // Mark as "attempted"
          await prisma.processingItem.update({
            where: { id: item.id },
            data: {
              checkpoint: {
                deliveredServers,
                failedServers: [...(checkpoint.failedServers || []), target.serverId]
              }
            }
          });
        } else {
          // Transient error - throw to retry entire item
          throw error;
        }
      }
    }

    // Check if all servers delivered
    const allDelivered = targets.every(t =>
      deliveredServers.includes(t.serverId)
    );

    if (allDelivered) {
      const failedServers = checkpoint.failedServers || [];

      if (failedServers.length > 0) {
        console.warn(`[${this.name}] Completed with failures: ${failedServers.join(", ")}`);
      }

      await pipelineOrchestrator.transitionStatus(item.id, "COMPLETED", {
        stepContext: {
          ...item.stepContext,
          deliver: {
            deliveredServers,
            failedServers,
          }
        }
      });

      console.log(`[${this.name}] Delivery complete: ${item.title}`);
    }
  }

  private isPermanentDeliveryError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes("not found") ||
      message.includes("permission denied") ||
      message.includes("disk full")
    );
  }

  private async handleError(item: ProcessingItem, error: Error): Promise<void> {
    console.error(`[${this.name}] Error processing ${item.title}:`, error);
    await pipelineOrchestrator.handleError(item.id, error);
  }
}
```

**Key features**:
- Checkpointing: Saves delivered servers
- Resume: Skips already delivered servers on retry
- Circuit breaker: Skips unhealthy servers
- Partial success: Can complete even if some servers fail

---

## Circuit Breaker System

### Purpose
Stop hammering services that are down. Track failure rates, open circuit when threshold exceeded, attempt recovery after timeout.

### States
- **CLOSED**: Service healthy, requests allowed
- **OPEN**: Service down, requests blocked for timeout period
- **HALF_OPEN**: Testing if service recovered

### Implementation

```typescript
export class CircuitBreakerService {
  private readonly FAILURE_THRESHOLD = 5;
  private readonly TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private readonly HALF_OPEN_ATTEMPTS = 1;

  async isHealthy(service: string): Promise<boolean> {
    const breaker = await this.getBreaker(service);

    if (!breaker) {
      return true; // No breaker = healthy
    }

    if (breaker.state === "CLOSED") {
      return true;
    }

    if (breaker.state === "OPEN") {
      // Check if timeout expired
      if (breaker.opensAt && new Date() >= breaker.opensAt) {
        // Move to half-open
        await this.setHalfOpen(service);
        return true; // Allow one attempt
      }
      return false; // Still open
    }

    if (breaker.state === "HALF_OPEN") {
      return true; // Testing
    }

    return false;
  }

  async recordSuccess(service: string): Promise<void> {
    const breaker = await this.getBreaker(service);

    if (!breaker) {
      return;
    }

    // Close circuit on success
    await prisma.circuitBreaker.update({
      where: { service },
      data: {
        state: "CLOSED",
        failures: 0,
        lastFailure: null,
        opensAt: null,
      }
    });

    console.log(`[CircuitBreaker] ${service} recovered`);
  }

  async recordFailure(service: string, error: Error): Promise<void> {
    let breaker = await this.getBreaker(service);

    if (!breaker) {
      breaker = await prisma.circuitBreaker.create({
        data: {
          service,
          state: "CLOSED",
          failures: 0,
        }
      });
    }

    const newFailures = breaker.failures + 1;

    if (newFailures >= this.FAILURE_THRESHOLD) {
      // Open circuit
      const opensAt = new Date(Date.now() + this.TIMEOUT_MS);

      await prisma.circuitBreaker.update({
        where: { service },
        data: {
          state: "OPEN",
          failures: newFailures,
          lastFailure: new Date(),
          opensAt,
        }
      });

      console.warn(`[CircuitBreaker] ${service} circuit OPENED (${newFailures} failures)`);
    } else {
      // Increment failures
      await prisma.circuitBreaker.update({
        where: { service },
        data: {
          failures: newFailures,
          lastFailure: new Date(),
        }
      });
    }
  }

  private async getBreaker(service: string) {
    return await prisma.circuitBreaker.findUnique({
      where: { service }
    });
  }

  private async setHalfOpen(service: string) {
    await prisma.circuitBreaker.update({
      where: { service },
      data: { state: "HALF_OPEN" }
    });
  }
}

export const circuitBreaker = new CircuitBreakerService();
```

### Usage

```typescript
// In SearchWorker
for (const indexer of indexers) {
  const isHealthy = await circuitBreaker.isHealthy(`indexer:${indexer.id}`);

  if (!isHealthy) {
    console.log(`Skipping ${indexer.name} - circuit open`);
    continue;
  }

  try {
    const results = await searchIndexer(indexer, query);
    await circuitBreaker.recordSuccess(`indexer:${indexer.id}`);
    return results;
  } catch (error) {
    await circuitBreaker.recordFailure(`indexer:${indexer.id}`, error);
  }
}
```

---

## Smart Retry Strategy

### Error Classification

```typescript
enum ErrorType {
  PERMANENT = "PERMANENT",     // Don't retry
  TRANSIENT = "TRANSIENT",     // Retry with backoff
  SERVICE_DOWN = "SERVICE_DOWN" // Skip until service recovers
}

class SmartRetryStrategy {
  classifyError(error: Error): ErrorType {
    const message = error.message.toLowerCase();

    // Permanent errors
    if (
      message.includes("not found") ||
      message.includes("invalid") ||
      message.includes("no releases") ||
      message.includes("forbidden")
    ) {
      return ErrorType.PERMANENT;
    }

    // Service down
    if (
      message.includes("econnrefused") ||
      message.includes("503") ||
      message.includes("circuit open") ||
      message.includes("no encoders available")
    ) {
      return ErrorType.SERVICE_DOWN;
    }

    // Default to transient
    return ErrorType.TRANSIENT;
  }

  async handleError(item: ProcessingItem, error: Error): Promise<void> {
    const errorType = this.classifyError(error);

    switch (errorType) {
      case ErrorType.PERMANENT:
        // Fail immediately
        await pipelineOrchestrator.transitionStatus(item.id, "FAILED", {
          error: error.message
        });
        break;

      case ErrorType.SERVICE_DOWN:
        // Skip until service recovers (don't count as attempt)
        await prisma.processingItem.update({
          where: { id: item.id },
          data: {
            skipUntil: new Date(Date.now() + 5 * 60 * 1000),
            lastError: error.message,
          }
        });
        break;

      case ErrorType.TRANSIENT:
        // Retry with backoff
        const newAttempts = item.attempts + 1;

        if (newAttempts >= item.maxAttempts) {
          await pipelineOrchestrator.transitionStatus(item.id, "FAILED", {
            error: `Failed after ${newAttempts} attempts: ${error.message}`
          });
        } else {
          const backoff = Math.min(
            60000 * Math.pow(2, newAttempts), // 1min, 2min, 4min, 8min...
            30 * 60 * 1000 // Max 30 min
          );

          await prisma.processingItem.update({
            where: { id: item.id },
            data: {
              attempts: newAttempts,
              nextRetryAt: new Date(Date.now() + backoff),
              lastError: error.message,
            }
          });
        }
        break;
    }
  }
}
```

**Key difference**: `skipUntil` doesn't increment attempts. Service being down isn't the item's fault.

---

## Stall Detection

### Progress-Based Detection

```typescript
async detectStalls(items: ProcessingItem[], threshold: number): Promise<ProcessingItem[]> {
  const stalled: ProcessingItem[] = [];

  for (const item of items) {
    // Compare current progress to last known value
    const progressChanged = item.progress !== item.lastProgressValue;

    if (!progressChanged && item.lastProgressUpdate) {
      const stallTime = Date.now() - item.lastProgressUpdate.getTime();

      if (stallTime > threshold) {
        stalled.push(item);
      }
    }
  }

  return stalled;
}
```

**Thresholds by status**:
- DOWNLOADING: 30 minutes (large files can be slow)
- ENCODING: 10 minutes (should always show progress)
- DELIVERING: 5 minutes (SFTP transfers show progress)

**Not**: "Item in status for X minutes" - that's arbitrary and dumb.

---

## Workers to Remove

The following workers are **no longer needed** with the new design:

1. **DownloadProgressWorker** - DownloadWorker handles monitoring
2. **DownloadRecoveryWorker** - DownloadWorker detects stalls
3. **EncoderMonitorWorker** - EncodeWorker handles monitoring
4. **StuckItemRecoveryWorker** - Each worker detects its own stalls

Only keep:
- SearchWorker
- DownloadWorker (new design)
- EncodeWorker (new design)
- DeliverWorker (new design)

---

## Implementation Plan

### Phase 1: Database Schema
1. Add new fields to ProcessingItem
2. Create CircuitBreaker table
3. Run migration

### Phase 2: Core Services
1. Implement CircuitBreakerService
2. Implement SmartRetryStrategy
3. Update PipelineOrchestrator.handleError()

### Phase 3: Worker Redesign
1. Rewrite DownloadWorker (new design)
2. Rewrite EncodeWorker (new design)
3. Rewrite DeliverWorker (checkpointing)
4. Keep SearchWorker (mostly unchanged)

### Phase 4: Remove Old Workers
1. Delete DownloadProgressWorker
2. Delete DownloadRecoveryWorker
3. Delete EncoderMonitorWorker
4. Delete StuckItemRecoveryWorker

### Phase 5: Testing
1. Test download flow (new → complete)
2. Test encoding flow (queuing → complete)
3. Test delivery flow (checkpointing)
4. Test error scenarios (stalls, failures)
5. Test circuit breaker (service outages)
6. Test crash recovery (restart mid-process)

### Phase 6: Monitoring
1. Add metrics to workers
2. Add stall alerts
3. Add circuit breaker alerts
4. Dashboard for pipeline health

---

## Migration Strategy

### Zero Downtime Migration

1. **Run both systems in parallel**:
   - New workers process new requests
   - Old workers finish existing requests
   - No migration of in-flight items

2. **Feature flag**:
   ```typescript
   const USE_NEW_WORKERS = process.env.USE_NEW_WORKERS === "true";
   ```

3. **Gradual rollout**:
   - Week 1: 10% of requests use new system
   - Week 2: 50% of requests use new system
   - Week 3: 100% of requests use new system
   - Week 4: Remove old workers

### Rollback Plan

If issues arise:
1. Set `USE_NEW_WORKERS=false`
2. Old workers resume processing
3. Fix issues, redeploy
4. Re-enable new workers

---

## Success Metrics

### Before (Current System)
- Items stuck for hours: Common
- Recovery workers needed: 4
- While loops: 2+ per request
- Crash resilience: Poor (loses in-flight work)
- Service outages: Fail requests immediately
- Retry on partial failure: Start from scratch

### After (New System)
- Items stuck for hours: Impossible (stall detection)
- Recovery workers needed: 0
- While loops: 0
- Crash resilience: Perfect (resume from database)
- Service outages: Skip and retry later
- Retry on partial failure: Resume from checkpoint

### Key Metrics to Track
1. **Time to completion**: Average time from PENDING → COMPLETED
2. **Failure rate**: % of requests that reach FAILED
3. **Stall detection**: Items caught before timeout
4. **Circuit breaker activations**: Services experiencing issues
5. **Checkpoint resumes**: Items resumed from partial work

---

## Conclusion

This redesign eliminates all the fundamental flaws:

1. ✅ No while loops - everything scheduled
2. ✅ No stuck items - progress-based stall detection
3. ✅ No race conditions - single worker per status
4. ✅ No recovery workers - workers handle their own health
5. ✅ Crash resilient - all state in database
6. ✅ Graceful degradation - circuit breakers skip dead services
7. ✅ Efficient retries - checkpoint partial work

The result: A bulletproof request pipeline that only fails when truly out of our control.
