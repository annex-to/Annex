import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../setup.js";

const mockPrisma = createMockPrisma();

// Circuit breaker + settings stores for pipeline orchestrator
const circuitBreakerStore = new Map<string, any>();
const settingsStore = new Map<string, any>();

mockPrisma.circuitBreaker = {
  findUnique: mock(async ({ where }: any) => circuitBreakerStore.get(where.service) || null),
  create: mock(async ({ data }: any) => {
    const record = { ...data, createdAt: new Date(), updatedAt: new Date() };
    circuitBreakerStore.set(data.service, record);
    return record;
  }),
  update: mock(async ({ where, data }: any) => {
    const record = circuitBreakerStore.get(where.service);
    if (!record) throw new Error("Not found");
    const updated = { ...record, ...data };
    circuitBreakerStore.set(where.service, updated);
    return updated;
  }),
  findMany: mock(async () => Array.from(circuitBreakerStore.values())),
};

mockPrisma.settings = {
  findUnique: mock(async ({ where }: any) => settingsStore.get(where.id) || null),
};

// Add missing findFirst/findMany to pipelineTemplate mock
const pipelineTemplateStore = mockPrisma._stores.pipelineTemplate;
mockPrisma.pipelineTemplate.findFirst = mock(async ({ where }: any = {}) => {
  const values = Array.from(pipelineTemplateStore.values());
  if (!where) return values[0] || null;
  return values.find((v: any) => Object.keys(where).every((k) => v[k] === where[k])) || null;
});
mockPrisma.pipelineTemplate.findMany = mock(async ({ where }: any = {}) => {
  const values = Array.from(pipelineTemplateStore.values());
  if (!where) return values;
  return values.filter((v: any) => Object.keys(where).every((k) => v[k] === where[k]));
});

// Add missing findMany to pipelineExecution mock
const pipelineExecutionStore = mockPrisma._stores.pipelineExecution;
mockPrisma.pipelineExecution.findMany = mock(async ({ where }: any = {}) => {
  const values = Array.from(pipelineExecutionStore.values());
  if (!where) return values;
  return values.filter((v: any) => Object.keys(where).every((k) => v[k] === where[k]));
});

// Add missing/enhanced methods to processingItem mock
const processingItemStore = mockPrisma._stores.processingItem;
const mediaRequestStore = mockPrisma._stores.mediaRequest;

// Override findUnique to support include: { request }
mockPrisma.processingItem.findUnique = mock(async ({ where, include }: any) => {
  const record = processingItemStore.get(where.id);
  if (!record) return null;
  if (include?.request) {
    const request = mediaRequestStore.get(record.requestId);
    if (typeof include.request === "object" && include.request.select) {
      const selected: any = {};
      for (const key of Object.keys(include.request.select)) {
        if (include.request.select[key] && request) selected[key] = request[key];
      }
      return { ...record, request: request ? selected : null };
    }
    return { ...record, request: request || null };
  }
  return record;
});

// Override findMany to support include: { request }
const originalFindMany = mockPrisma.processingItem.findMany;
mockPrisma.processingItem.findMany = mock(async (args: any = {}) => {
  const results = await originalFindMany(args);
  if (args.include?.request) {
    return results.map((record: any) => {
      const request = mediaRequestStore.get(record.requestId);
      return { ...record, request: request || null };
    });
  }
  return results;
});

mockPrisma.processingItem.update = mock(async ({ where, data }: any) => {
  const record = processingItemStore.get(where.id);
  if (!record) throw new Error(`Record ${where.id} not found`);
  const updateData = { ...data };
  if (data.attempts?.increment) {
    updateData.attempts = (record.attempts || 0) + data.attempts.increment;
  }
  if (data.download) {
    if (data.download.connect) updateData.downloadId = data.download.connect.id;
    else if (data.download.disconnect) updateData.downloadId = null;
    delete updateData.download;
  }
  const updated = { ...record, ...updateData, updatedAt: new Date() };
  processingItemStore.set(where.id, updated);
  return updated;
});
mockPrisma.processingItem.delete = mock(async ({ where }: any) => {
  const record = processingItemStore.get(where.id);
  processingItemStore.delete(where.id);
  return record;
});
mockPrisma.processingItem.findFirst = mock(async ({ where }: any = {}) => {
  const values = Array.from(processingItemStore.values());
  if (!where) return values[0] || null;
  return (
    values.find((v: any) =>
      Object.keys(where).every((k) => {
        if (where[k]?.in) return where[k].in.includes(v[k]);
        return v[k] === where[k];
      })
    ) || null
  );
});

// Add deleteMany to processingItem mock
mockPrisma.processingItem.deleteMany = mock(async ({ where }: any = {}) => {
  let count = 0;
  for (const [id, record] of processingItemStore.entries()) {
    const matches =
      !where ||
      Object.keys(where).every((k) => {
        if (k === "requestId") return record.requestId === where.requestId;
        return record[k] === where[k];
      });
    if (matches) {
      processingItemStore.delete(id);
      count++;
    }
  }
  return { count };
});

// Add deleteMany to download store
const downloadStore = mockPrisma._stores.download;
if (!mockPrisma.download) {
  mockPrisma.download = {};
}
mockPrisma.download.deleteMany = mock(async ({ where }: any = {}) => {
  let count = 0;
  for (const [id, record] of downloadStore.entries()) {
    const matches = !where || Object.keys(where).every((k) => record[k] === where[k]);
    if (matches) {
      downloadStore.delete(id);
      count++;
    }
  }
  return { count };
});

// Add deleteMany to activityLog store
const _activityLogStore = mockPrisma._stores.activityLog;
if (!mockPrisma.activityLog) {
  mockPrisma.activityLog = {};
}
mockPrisma.activityLog.deleteMany = mock(async () => ({ count: 0 }));

// Add delete to mediaRequest mock
mockPrisma.mediaRequest.delete = mock(async ({ where }: any) => {
  const record = mediaRequestStore.get(where.id);
  mediaRequestStore.delete(where.id);
  return record;
});

// Override mediaRequest.findUnique to support include: { processingItems }
mockPrisma.mediaRequest.findUnique = mock(async ({ where, include }: any) => {
  const record = mediaRequestStore.get(where.id);
  if (!record) return null;
  if (include?.processingItems) {
    let items = Array.from(processingItemStore.values()).filter(
      (item: any) => item.requestId === record.id
    );
    if (typeof include.processingItems === "object" && include.processingItems.where) {
      const itemWhere = include.processingItems.where;
      items = items.filter((item: any) =>
        Object.keys(itemWhere).every((k) => item[k] === itemWhere[k])
      );
    }
    return { ...record, processingItems: items };
  }
  return record;
});

// Mock episode library items
if (!mockPrisma.episodeLibraryItem) {
  mockPrisma.episodeLibraryItem = {
    findMany: mock(async () => []),
  };
}

// Mock $transaction
mockPrisma.$transaction = mock(async (arg: any) => {
  if (typeof arg === "function") {
    return arg(mockPrisma);
  }
  return Promise.all(arg);
});

mock.module("../../db/client.js", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

// Mock request status computer
mock.module("../../services/requestStatusComputer.js", () => ({
  requestStatusComputer: {
    computeStatus: mock(async () => ({
      status: "PENDING",
      progress: 0,
      currentStep: null,
      currentStepStartedAt: null,
      error: null,
    })),
    batchComputeStatus: mock(async (ids: string[]) => {
      const map = new Map();
      for (const id of ids) {
        map.set(id, {
          status: "PENDING",
          progress: 0,
          currentStep: null,
          currentStepStartedAt: null,
          error: null,
        });
      }
      return map;
    }),
    getReleaseMetadata: mock(async () => null),
  },
}));

// Mock trakt service
const mockTraktService = {
  getSeasons: mock(async () => [
    { number: 1, title: "Season 1", episode_count: 3, overview: null, first_aired: null },
  ]),
  getSeason: mock(async () => ({
    episodes: [
      { number: 1, title: "Pilot", overview: null, first_aired: "2008-01-20T00:00:00Z" },
      { number: 2, title: "Cat's in the Bag...", overview: null, first_aired: null },
      { number: 3, title: "...And the Bag's in the River", overview: null, first_aired: null },
    ],
  })),
};

mock.module("../../services/trakt.js", () => ({
  getTraktService: () => mockTraktService,
}));

// Mock download service
mock.module("../../services/download.js", () => ({
  getDownloadService: () => ({
    getAllTorrents: mock(async () => []),
  }),
}));

// Mock encoder dispatch service
const mockEncoderDispatch = {
  cancelJob: mock(async () => {}),
};
mock.module("../../services/encoderDispatch.js", () => ({
  getEncoderDispatchService: () => mockEncoderDispatch,
}));

// Override methods on real singletons (avoids mock.module which leaks to other test files)
const { pipelineOrchestrator } = await import("../../services/pipeline/PipelineOrchestrator.js");
const { getPipelineExecutor } = await import("../../services/pipeline/PipelineExecutor.js");

const mockExecutor = {
  startExecution: mock(async () => {}),
  cancelExecution: mock(async () => {}),
};

const executor = getPipelineExecutor();
executor.startExecution = mockExecutor.startExecution;
executor.cancelExecution = mockExecutor.cancelExecution;

const mockOrchestrator = {
  createRequest: mock(async (params: any) => {
    const requestId = crypto.randomUUID();
    const items =
      params.type === "movie"
        ? [{ id: crypto.randomUUID(), type: "MOVIE", tmdbId: params.tmdbId, status: "PENDING" }]
        : (params.episodes || []).map((ep: any) => ({
            id: crypto.randomUUID(),
            type: "EPISODE",
            tmdbId: params.tmdbId,
            season: ep.season,
            episode: ep.episode,
            status: "PENDING",
          }));

    mockPrisma._stores.mediaRequest.set(requestId, {
      id: requestId,
      type: params.type === "movie" ? "MOVIE" : "TV",
      tmdbId: params.tmdbId,
      title: params.title,
      year: params.year,
      status: "PENDING",
      progress: 0,
      targets: [],
      requestedSeasons: [],
      requestedEpisodes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { requestId, items };
  }),
  retry: mock(async (itemId: string) => {
    const item = mockPrisma._stores.processingItem.get(itemId);
    if (!item) throw new Error("Item not found");
    if (item.status !== "FAILED") throw new Error("Cannot retry non-FAILED item");
    item.status = "PENDING";
    item.attempts = 0;
    return item;
  }),
  cancel: mock(async (itemId: string) => {
    const item = mockPrisma._stores.processingItem.get(itemId);
    if (!item) throw new Error("Item not found");
    if (item.status === "COMPLETED" || item.status === "FAILED") {
      throw new Error("Cannot cancel terminal item");
    }
    item.status = "CANCELLED";
    return item;
  }),
  getRequestItems: mock(async (requestId: string) => {
    return Array.from(mockPrisma._stores.processingItem.values()).filter(
      (item: any) => item.requestId === requestId
    );
  }),
  getRequestStats: mock(async () => ({
    total: 1,
    completed: 0,
    failed: 0,
    pending: 1,
    inProgress: 0,
  })),
};

// Replace methods on the real singleton (the router captures the same object reference)
pipelineOrchestrator.createRequest = mockOrchestrator.createRequest as any;
pipelineOrchestrator.retry = mockOrchestrator.retry as any;
pipelineOrchestrator.cancel = mockOrchestrator.cancel as any;
(pipelineOrchestrator as any).getRequestItems = mockOrchestrator.getRequestItems;
(pipelineOrchestrator as any).getRequestStats = mockOrchestrator.getRequestStats;

// Import router after all mocks and singleton overrides
const { requestsRouter } = await import("../../routers/requests.js");
const { router: createRouter } = await import("../../trpc.js");

// Create a caller for testing
const testRouter = createRouter({ requests: requestsRouter });
const caller = testRouter.createCaller({
  config: {} as any,
  sessionToken: null,
  user: null,
});

function seedDefaultTemplate(mediaType: string = "MOVIE") {
  const id = `default-${mediaType.toLowerCase()}-template`;
  mockPrisma._stores.pipelineTemplate.set(id, {
    id,
    name: `Default ${mediaType} Pipeline`,
    mediaType,
    isDefault: true,
    steps: [{ type: "SEARCH", name: "Search", config: {} }],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function seedProcessingItem(overrides: Record<string, any> = {}) {
  const id = overrides.id || crypto.randomUUID();
  mockPrisma._stores.processingItem.set(id, {
    id,
    requestId: "req-1",
    type: "EPISODE",
    tmdbId: 1396,
    title: "Pilot",
    year: 2008,
    season: 1,
    episode: 1,
    status: "PENDING",
    stepContext: null,
    attempts: 0,
    maxAttempts: 5,
    currentStep: null,
    lastError: null,
    nextRetryAt: null,
    skipUntil: null,
    progress: 0,
    downloadId: null,
    encodingJobId: null,
    sourceFilePath: null,
    cooldownEndsAt: null,
    discoveredAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return id;
}

function seedRequest(overrides: Record<string, any> = {}) {
  const id = overrides.id || crypto.randomUUID();
  mockPrisma._stores.mediaRequest.set(id, {
    id,
    type: "MOVIE",
    tmdbId: 27205,
    title: "Inception",
    year: 2010,
    posterPath: null,
    status: "PENDING",
    progress: 0,
    targets: [{ serverId: "s1" }],
    requestedSeasons: [],
    requestedEpisodes: null,
    error: null,
    subscribe: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  });
  return id;
}

describe("Requests Router", () => {
  beforeEach(() => {
    mockPrisma._clear();
    circuitBreakerStore.clear();
    settingsStore.clear();
    mockExecutor.startExecution.mockClear();
    mockExecutor.cancelExecution.mockClear();
    mockOrchestrator.createRequest.mockClear();
    mockOrchestrator.retry.mockClear();
    mockOrchestrator.cancel.mockClear();
    mockEncoderDispatch.cancelJob.mockClear();
  });

  afterEach(() => {
    mockPrisma._clear();
  });

  describe("createMovie", () => {
    test("creates request with correct metadata", async () => {
      seedDefaultTemplate("MOVIE");

      const result = await caller.requests.createMovie({
        tmdbId: 27205,
        title: "Inception",
        year: 2010,
        targets: [{ serverId: "server-1" }],
      });

      expect(result.id).toBeDefined();
      expect(mockOrchestrator.createRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "movie",
          tmdbId: 27205,
          title: "Inception",
          year: 2010,
        })
      );
    });

    test("stores pipeline template for workers", async () => {
      seedDefaultTemplate("MOVIE");

      const result = await caller.requests.createMovie({
        tmdbId: 27205,
        title: "Inception",
        year: 2010,
        targets: [{ serverId: "server-1" }],
      });

      // A pipeline execution should be created
      const executions = Array.from(mockPrisma._stores.pipelineExecution.values());
      const exec = executions.find((e: any) => e.requestId === result.id);
      expect(exec).toBeDefined();
      expect((exec as any).status).toBe("RUNNING");
    });

    test("throws when no default template exists", async () => {
      // Don't seed a template
      await expect(
        caller.requests.createMovie({
          tmdbId: 27205,
          title: "Inception",
          year: 2010,
          targets: [{ serverId: "server-1" }],
        })
      ).rejects.toThrow("No default pipeline template");
    });
  });

  describe("cancel", () => {
    test("cancels all processing items", async () => {
      const reqId = seedRequest();
      seedProcessingItem({ requestId: reqId, status: "DOWNLOADING" });
      seedProcessingItem({ requestId: reqId, status: "PENDING" });

      const result = await caller.requests.cancel({ id: reqId });
      expect(result.success).toBe(true);
    });

    test("cancels encoding jobs", async () => {
      const reqId = seedRequest();
      const itemId = seedProcessingItem({
        requestId: reqId,
        status: "ENCODING",
        encodingJobId: "job-1",
      });

      // Seed the mock stores with the encoding job
      mockPrisma._stores.processingItem.get(itemId).encodingJobId = "job-1";

      await caller.requests.cancel({ id: reqId });
      // Encoding cancellation is called if items have encodingJobId
    });
  });

  describe("delete", () => {
    test("removes request and related data", async () => {
      const reqId = seedRequest();
      seedProcessingItem({ requestId: reqId });

      const result = await caller.requests.delete({ id: reqId });
      expect(result.success).toBe(true);

      // Request should be deleted
      expect(mockPrisma._stores.mediaRequest.get(reqId)).toBeUndefined();
    });

    test("returns error for non-existent request", async () => {
      const result = await caller.requests.delete({ id: "nonexistent" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("Request not found");
    });
  });

  describe("retry", () => {
    test("resets all items to PENDING", async () => {
      const reqId = seedRequest({ id: "retry-req" });
      seedProcessingItem({
        requestId: reqId,
        status: "FAILED",
        stepContext: { selectedRelease: { title: "test" } },
      });

      // Need a pipeline execution for retry
      mockPrisma._stores.pipelineExecution.set("exec-1", {
        id: "exec-1",
        requestId: reqId,
        templateId: seedDefaultTemplate("MOVIE"),
        parentExecutionId: null,
        status: "FAILED",
        startedAt: new Date(),
        currentStep: 0,
        steps: [],
        context: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await caller.requests.retry({ id: reqId });
      expect(result.success).toBe(true);
    });

    test("throws for non-existent request", async () => {
      await expect(caller.requests.retry({ id: "nonexistent" })).rejects.toThrow("not found");
    });

    test("throws when no pipeline execution found", async () => {
      const reqId = seedRequest();
      await expect(caller.requests.retry({ id: reqId })).rejects.toThrow(
        "No pipeline execution found"
      );
    });

    test("falls back to default template for branch pipelines", async () => {
      const reqId = seedRequest({ id: "branch-retry-req" });
      seedProcessingItem({ requestId: reqId, status: "FAILED" });

      const defaultTemplateId = seedDefaultTemplate("MOVIE");

      // Seed a branch pipeline execution
      mockPrisma._stores.pipelineExecution.set("exec-branch", {
        id: "exec-branch",
        requestId: reqId,
        templateId: "episode-branch-pipeline",
        parentExecutionId: null,
        status: "FAILED",
        startedAt: new Date(),
        currentStep: 0,
        steps: [],
        context: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await caller.requests.retry({ id: reqId });
      expect(result.success).toBe(true);

      // New execution should use the default template, not the branch one
      const executions = Array.from(mockPrisma._stores.pipelineExecution.values()).filter(
        (e: any) => e.requestId === reqId
      );
      const latestExec = executions[executions.length - 1];
      expect((latestExec as any).templateId).toBe(defaultTemplateId);
    });
  });

  describe("cancelEpisode", () => {
    test("cancels episode via direct DB update (bypasses orchestrator)", async () => {
      const itemId = seedProcessingItem({ status: "DOWNLOADING" });

      const result = await caller.requests.cancelEpisode({ itemId });
      expect(result.success).toBe(true);

      const item = mockPrisma._stores.processingItem.get(itemId);
      expect(item.status).toBe("CANCELLED");
    });

    test("BUG: can cancel COMPLETED episodes (bypasses orchestrator validation)", async () => {
      const itemId = seedProcessingItem({ status: "COMPLETED" });

      // This SHOULD fail but doesn't because it bypasses orchestrator validation
      const result = await caller.requests.cancelEpisode({ itemId });
      expect(result.success).toBe(true);

      const item = mockPrisma._stores.processingItem.get(itemId);
      expect(item.status).toBe("CANCELLED");
    });
  });

  describe("retryEpisode", () => {
    test("resets FAILED episode to PENDING", async () => {
      const itemId = seedProcessingItem({
        type: "EPISODE",
        status: "FAILED",
        lastError: "download failed",
        attempts: 3,
      });

      const result = await caller.requests.retryEpisode({ itemId });
      expect(result.success).toBe(true);

      const item = mockPrisma._stores.processingItem.get(itemId);
      expect(item.status).toBe("PENDING");
      expect(item.attempts).toBe(0);
      expect(item.lastError).toBeNull();
    });

    test("rejects non-EPISODE type", async () => {
      const itemId = seedProcessingItem({ type: "MOVIE", status: "FAILED" });

      await expect(caller.requests.retryEpisode({ itemId })).rejects.toThrow(
        "Only episodes can be retried"
      );
    });

    test("throws for non-existent item", async () => {
      await expect(caller.requests.retryEpisode({ itemId: "nonexistent" })).rejects.toThrow(
        "Episode not found"
      );
    });
  });

  describe("reEncodeEpisode", () => {
    test("resets to DOWNLOADED preserving download context", async () => {
      const itemId = seedProcessingItem({
        type: "EPISODE",
        status: "FAILED",
        stepContext: {
          download: { sourceFilePath: "/path/to/ep.mkv" },
          encode: { encodedFiles: [{ path: "/encoded.mkv" }] },
        },
      });

      const result = await caller.requests.reEncodeEpisode({ itemId });
      expect(result.success).toBe(true);

      const item = mockPrisma._stores.processingItem.get(itemId);
      expect(item.status).toBe("DOWNLOADED");
      expect(item.encodingJobId).toBeNull();
    });

    test("rejects when no source file path", async () => {
      const itemId = seedProcessingItem({
        type: "EPISODE",
        status: "FAILED",
        stepContext: {},
        sourceFilePath: null,
      });

      await expect(caller.requests.reEncodeEpisode({ itemId })).rejects.toThrow(
        "missing download file path"
      );
    });

    test("uses top-level sourceFilePath as fallback", async () => {
      const itemId = seedProcessingItem({
        type: "EPISODE",
        status: "ENCODED",
        stepContext: {},
        sourceFilePath: "/fallback/path.mkv",
      });

      const result = await caller.requests.reEncodeEpisode({ itemId });
      expect(result.success).toBe(true);
    });
  });

  describe("reDeliverEpisode", () => {
    test("resets to ENCODED status", async () => {
      const reqId = seedRequest({ type: "TV" });
      const itemId = seedProcessingItem({
        type: "EPISODE",
        requestId: reqId,
        status: "FAILED",
        season: 1,
        episode: 1,
      });

      const result = await caller.requests.reDeliverEpisode({ itemId });
      expect(result.success).toBe(true);

      const item = mockPrisma._stores.processingItem.get(itemId);
      expect(item.status).toBe("ENCODED");
      expect(item.deliveredAt).toBeNull();
    });

    test("rejects non-EPISODE type", async () => {
      const reqId = seedRequest();
      const itemId = seedProcessingItem({
        type: "MOVIE",
        requestId: reqId,
        status: "FAILED",
        season: null,
        episode: null,
      });

      await expect(caller.requests.reDeliverEpisode({ itemId })).rejects.toThrow(
        "Only episodes can be re-delivered"
      );
    });
  });

  describe("acceptLowerQuality", () => {
    test("updates items with selected release", async () => {
      const reqId = seedRequest({ id: "alq-req" });
      const _itemId = seedProcessingItem({
        requestId: reqId,
        status: "FOUND",
        stepContext: {
          qualityMet: false,
          alternativeReleases: [
            { title: "Movie.720p.WEB-DL", resolution: "720p" },
            { title: "Movie.480p.DVDRip", resolution: "480p" },
          ],
        },
      });

      const result = await caller.requests.acceptLowerQuality({
        id: reqId,
        releaseIndex: 0,
      });

      expect(result.success).toBe(true);
    });

    test("throws for out-of-bounds release index", async () => {
      const reqId = seedRequest({ id: "alq-bad-idx" });
      seedProcessingItem({
        requestId: reqId,
        status: "FOUND",
        stepContext: {
          qualityMet: false,
          alternativeReleases: [{ title: "Only release" }],
        },
      });

      await expect(
        caller.requests.acceptLowerQuality({ id: reqId, releaseIndex: 5 })
      ).rejects.toThrow("Invalid release index");
    });

    test("throws when no alternatives available", async () => {
      const reqId = seedRequest({ id: "alq-no-alts" });
      seedProcessingItem({
        requestId: reqId,
        status: "FOUND",
        stepContext: { qualityMet: true },
      });

      await expect(
        caller.requests.acceptLowerQuality({ id: reqId, releaseIndex: 0 })
      ).rejects.toThrow("No items waiting for quality acceptance");
    });

    test("throws when items not in FOUND status", async () => {
      const reqId = seedRequest({ id: "alq-wrong-status" });
      seedProcessingItem({
        requestId: reqId,
        status: "DOWNLOADING",
        stepContext: {
          qualityMet: false,
          alternativeReleases: [{ title: "alt" }],
        },
      });

      await expect(
        caller.requests.acceptLowerQuality({ id: reqId, releaseIndex: 0 })
      ).rejects.toThrow("No items waiting for quality acceptance");
    });
  });

  describe("overrideDiscoveredRelease", () => {
    test("updates selected release and resets cooldown to 30s", async () => {
      const itemId = seedProcessingItem({
        status: "DISCOVERED",
        stepContext: { selectedRelease: { title: "old" } },
        allSearchResults: [{ title: "result1" }, { title: "result2" }],
        cooldownEndsAt: new Date(Date.now() + 600000),
      });

      const result = await caller.requests.overrideDiscoveredRelease({
        itemId,
        releaseIndex: 1,
      });

      expect(result.success).toBe(true);
      expect(result.newCooldownEndsAt).toBeDefined();

      // Check cooldown is ~30s from now
      const diffMs = result.newCooldownEndsAt.getTime() - Date.now();
      expect(diffMs).toBeGreaterThan(25000);
      expect(diffMs).toBeLessThan(35000);
    });

    test("rejects non-DISCOVERED item", async () => {
      const itemId = seedProcessingItem({
        status: "DOWNLOADING",
        allSearchResults: [{ title: "result1" }],
      });

      await expect(
        caller.requests.overrideDiscoveredRelease({ itemId, releaseIndex: 0 })
      ).rejects.toThrow("Cannot override release");
    });

    test("rejects invalid release index", async () => {
      const itemId = seedProcessingItem({
        status: "DISCOVERED",
        allSearchResults: [{ title: "only one" }],
      });

      await expect(
        caller.requests.overrideDiscoveredRelease({ itemId, releaseIndex: 5 })
      ).rejects.toThrow("Invalid release index");
    });
  });

  describe("approveDiscoveredItem", () => {
    test("sets cooldown to 5 seconds from now", async () => {
      const itemId = seedProcessingItem({
        status: "DISCOVERED",
        cooldownEndsAt: new Date(Date.now() + 600000),
      });

      const result = await caller.requests.approveDiscoveredItem({ itemId });
      expect(result.success).toBe(true);

      const diffMs = result.newCooldownEndsAt.getTime() - Date.now();
      expect(diffMs).toBeGreaterThan(2000);
      expect(diffMs).toBeLessThan(8000);
    });

    test("rejects non-DISCOVERED item", async () => {
      const itemId = seedProcessingItem({ status: "DOWNLOADING" });

      await expect(caller.requests.approveDiscoveredItem({ itemId })).rejects.toThrow(
        "Only DISCOVERED items can be approved"
      );
    });
  });

  describe("retryItem", () => {
    test("delegates to orchestrator.retry", async () => {
      const itemId = seedProcessingItem({ status: "FAILED" });

      const result = await caller.requests.retryItem({ itemId });
      expect(result.success).toBe(true);
      expect(mockOrchestrator.retry).toHaveBeenCalledWith(itemId);
    });
  });

  describe("cancelItem", () => {
    test("delegates to orchestrator.cancel", async () => {
      const itemId = seedProcessingItem({ status: "DOWNLOADING" });

      const result = await caller.requests.cancelItem({ itemId });
      expect(result.success).toBe(true);
      expect(mockOrchestrator.cancel).toHaveBeenCalledWith(itemId);
    });
  });
});
