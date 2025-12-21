# Pipeline Testing Infrastructure

Comprehensive testing framework for validating pipeline logic without external dependencies.

## Quick Start

```bash
# Run all pipeline tests
bun test packages/server/src/services/pipeline/__tests__

# Run specific test file
bun test packages/server/src/services/pipeline/__tests__/steps/SearchStep.test.ts

# Run integration tests only
bun test packages/server/src/services/pipeline/__tests__/integration
```

## Architecture

```
__tests__/
├── test-utils/          # Testing utilities
│   ├── context-builder.ts    # Fluent API for creating test contexts
│   ├── assertions.ts         # Custom pipeline assertions
│   └── database.ts           # Database helpers
├── mocks/               # Mock implementations
│   ├── indexer.mock.ts       # Mock IndexerService
│   └── downloadManager.mock.ts  # Mock DownloadManager
├── fixtures/            # Test data
│   ├── media.ts             # Movie/TV show fixtures
│   └── releases.ts          # Release fixtures
├── steps/               # Unit tests for individual steps
│   └── SearchStep.test.ts
└── integration/         # End-to-end pipeline tests
    └── movie-pipeline.test.ts
```

## Writing Tests

### Unit Tests for Pipeline Steps

Test individual steps in isolation:

```typescript
import { describe, test, beforeEach, afterEach } from "bun:test";
import { SearchStep } from "../../steps/SearchStep.js";
import { ContextBuilder } from "../test-utils/context-builder.js";
import { assertStepSuccess, assertStepData } from "../test-utils/assertions.js";
import { cleanupTestData, createTestRequest } from "../test-utils/database.js";
import { MockIndexerService, createMockRelease } from "../mocks/indexer.mock.js";
import { MOVIES, TARGETS } from "../fixtures/media.js";

describe("MyStep", () => {
  let mockIndexer: MockIndexerService;

  beforeEach(() => {
    mockIndexer = new MockIndexerService();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  test("should do something", async () => {
    // Create test request in database
    const request = await createTestRequest({
      ...MOVIES.INCEPTION,
      targets: TARGETS.SINGLE_1080P_SERVER,
    });

    // Build test context
    const context = new ContextBuilder()
      .forMovie("Inception", 2010, 27205)
      .withRequestId(request.id)
      .withTargets(TARGETS.SINGLE_1080P_SERVER)
      .build();

    // Configure mocks
    mockIndexer.addMockRelease(
      createMockRelease({ title: "Test.1080p.WEB-DL.H264" })
    );

    // Execute step
    const step = new SearchStep();
    const result = await step.execute(context, {});

    // Assert results
    assertStepSuccess(result);
    assertStepData(result, "search");
  });
});
```

### Integration Tests for Full Pipelines

Test complete pipeline flows:

```typescript
import { describe, test, beforeEach, afterEach } from "bun:test";
import { PipelineExecutor } from "../../PipelineExecutor.js";
import { cleanupTestData, createTestRequest } from "../test-utils/database.js";
import { MockIndexerService } from "../mocks/indexer.mock.js";
import { prisma } from "../../../../db/client.js";

describe("My Pipeline Flow", () => {
  let executor: PipelineExecutor;
  let templateId: string;

  beforeEach(async () => {
    executor = new PipelineExecutor();

    // Create pipeline template
    const template = await prisma.pipelineTemplate.create({
      data: {
        name: "Test Template",
        mediaType: "MOVIE",
        steps: [
          { type: "SEARCH", name: "search", config: {} },
          { type: "DOWNLOAD", name: "download", config: {} },
        ],
      },
    });

    templateId = template.id;
  });

  afterEach(async () => {
    await cleanupTestData();
    await prisma.pipelineTemplate.deleteMany({});
  });

  test("should execute full pipeline", async () => {
    const request = await createTestRequest({ /* ... */ });

    await executor.startExecution(request.id, templateId);

    const execution = await prisma.pipelineExecution.findFirst({
      where: { requestId: request.id },
    });

    expect(execution?.status).toBe("COMPLETED");
  });
});
```

## Test Utilities

### ContextBuilder

Fluent API for creating pipeline contexts:

```typescript
const context = new ContextBuilder()
  .forMovie("Inception", 2010, 27205)
  .withRequestId("test-request-1")
  .withTargets([{ serverId: "server-1" }])
  .withSearchResult({
    selectedRelease: { /* release data */ },
  })
  .build();
```

### Custom Assertions

Pipeline-specific assertions:

```typescript
import {
  assertStepSuccess,
  assertStepFailure,
  assertStepRetry,
  assertStepSkipped,
  assertStepPaused,
  assertStepData,
  assertNextStep,
} from "../test-utils/assertions.js";

assertStepSuccess(result);
assertStepFailure(result, "Expected error message");
assertStepRetry(result);
assertStepData(result, "search", { qualityMet: true });
assertNextStep(result, "download");
```

### Database Helpers

```typescript
import {
  cleanupTestData,
  createTestRequest,
  createTestServer,
  getActivityLogs,
  getRequestStatus,
} from "../test-utils/database.js";

// Clean up after tests
await cleanupTestData();

// Create test data
const request = await createTestRequest({
  type: MediaType.MOVIE,
  tmdbId: 27205,
  title: "Inception",
  year: 2010,
});

const server = await createTestServer({
  name: "4K Server",
  maxResolution: "4K",
});

// Query test data
const logs = await getActivityLogs(request.id);
const status = await getRequestStatus(request.id);
```

## Mock Services

### MockIndexerService

```typescript
import { MockIndexerService, createMockRelease } from "../mocks/indexer.mock.js";

const mockIndexer = new MockIndexerService();

// Configure releases
mockIndexer.setMockReleases([
  createMockRelease({ title: "Release.1080p", resolution: "1080p" }),
  createMockRelease({ title: "Release.720p", resolution: "720p" }),
]);

// Verify search calls
const calls = mockIndexer.getSearchCalls();
expect(calls[0].title).toBe("Inception");
```

### MockDownloadManager

```typescript
import { MockDownloadManager, createMockTorrent } from "../mocks/downloadManager.mock.js";

const mockDownloadManager = new MockDownloadManager();

// Add existing torrents
mockDownloadManager.addMockTorrent(
  createMockTorrent("Movie.1080p", { isComplete: true })
);

// Verify calls
const calls = mockDownloadManager.getFindMovieCalls();
```

## Test Fixtures

Pre-configured test data for common scenarios:

```typescript
import { MOVIES, TV_SHOWS, TARGETS } from "../fixtures/media.js";
import { MOVIE_RELEASES, TV_SEASON_RELEASES } from "../fixtures/releases.js";

// Use fixture data
const request = await createTestRequest({
  ...MOVIES.INCEPTION,
  targets: TARGETS.SINGLE_4K_SERVER,
});

mockIndexer.setMockReleases([
  MOVIE_RELEASES.INCEPTION_4K_REMUX,
  MOVIE_RELEASES.INCEPTION_1080P_BLURAY,
]);
```

## Benefits

1. **Fast iteration** - Tests run in milliseconds, no waiting for downloads
2. **Deterministic** - Same inputs always produce same outputs
3. **Isolated** - No external dependencies or network calls
4. **Comprehensive** - Test edge cases easily with mock data
5. **Debuggable** - Clear failures with detailed assertions

## Best Practices

1. **Clean up after tests** - Always call `cleanupTestData()` in `afterEach`
2. **Use fixtures** - Leverage pre-configured test data from `/fixtures`
3. **Test edge cases** - No seeders, huge files, missing quality, etc.
4. **Verify side effects** - Check database updates, activity logs
5. **Mock external services** - Never hit real indexers/download managers in tests
6. **Name tests clearly** - Describe what scenario is being tested
7. **One assertion per test** - Keep tests focused and debuggable

## Common Patterns

### Testing Quality Filtering

```typescript
test("should filter releases by quality", async () => {
  mockIndexer.setMockReleases([
    createMockRelease({ resolution: "2160p" }),
    createMockRelease({ resolution: "1080p" }),
    createMockRelease({ resolution: "720p" }),
  ]);

  // ... execute with 1080p target

  // Verify correct quality selected
  expect(result.data?.search.selectedRelease.resolution).toBe("1080p");
});
```

### Testing Error Handling

```typescript
test("should handle errors gracefully", async () => {
  mockIndexer.search = async () => {
    throw new Error("Network error");
  };

  await executor.startExecution(request.id, templateId);

  const execution = await prisma.pipelineExecution.findFirst({
    where: { requestId: request.id },
  });

  expect(execution?.status).toBe("FAILED");
  expect(execution?.error).toContain("Network error");
});
```

### Testing Multi-Step Flows

```typescript
test("should pass data between steps", async () => {
  // Search step outputs selectedRelease
  // Download step should receive it in context

  await executor.startExecution(request.id, templateId);

  const execution = await prisma.pipelineExecution.findFirst({
    where: { requestId: request.id },
  });

  const context = execution?.context as any;
  expect(context.search.selectedRelease).toBeDefined();
  expect(context.download).toBeDefined();
  expect(context.download.torrentHash).toBeDefined();
});
```
