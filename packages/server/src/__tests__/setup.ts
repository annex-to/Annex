/**
 * Bun Test Setup
 *
 * Global setup for all tests. Runs before each test file.
 */

import { afterAll, afterEach, beforeAll, mock, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test temp directory for key files
let testTempDir: string;

// Store spies so we can restore them
let consoleLogSpy: ReturnType<typeof spyOn> | null = null;
let consoleWarnSpy: ReturnType<typeof spyOn> | null = null;

beforeAll(() => {
  // Create temp directory for test files
  testTempDir = mkdtempSync(join(tmpdir(), "annex-test-"));

  // Set test key path environment variable
  process.env.ANNEX_KEY_PATH = join(testTempDir, ".annex-key");

  // Suppress console output during tests unless DEBUG is set
  if (!process.env.DEBUG) {
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
  }
});

afterEach(() => {
  // Note: Bun doesn't have clearAllMocks, mocks are cleared individually if needed
});

afterAll(() => {
  // Clean up temp directory
  if (testTempDir && existsSync(testTempDir)) {
    rmSync(testTempDir, { recursive: true, force: true });
  }

  // Restore console
  consoleLogSpy?.mockRestore();
  consoleWarnSpy?.mockRestore();
});

/**
 * Create a test encryption key file
 */
export function createTestKeyFile(keyPath: string, keyLength = 32): Buffer {
  const key = randomBytes(keyLength);
  writeFileSync(keyPath, key);
  chmodSync(keyPath, 0o600);
  return key;
}

/**
 * Get the test temp directory
 */
export function getTestTempDir(): string {
  return testTempDir;
}

/**
 * Create a mock Prisma client for testing
 */
export function createMockPrisma() {
  const settingStore = new Map<string, { key: string; value: string; updatedAt: Date }>();
  const mediaRequestStore = new Map<string, any>();
  const pipelineTemplateStore = new Map<string, any>();
  const pipelineExecutionStore = new Map<string, any>();
  const processingItemStore = new Map<string, any>();
  const stepExecutionStore = new Map<string, any>();
  const notificationConfigStore = new Map<string, any>();
  const activityLogStore = new Map<string, any>();
  const approvalQueueStore = new Map<string, any>();
  const storageServerStore = new Map<string, any>();
  const tvEpisodeStore = new Map<string, any>();
  const episodeLibraryItemStore = new Map<string, any>();
  const downloadStore = new Map<string, any>();
  const mediaItemStore = new Map<string, any>();
  const indexerStore = new Map<string, any>();
  const cardigannIndexerStore = new Map<string, any>();
  const cardigannIndexerRateLimitRequestStore = new Map<string, any>();

  let idCounter = 1;
  const generateId = () => `test-id-${idCounter++}`;

  const mockPrismaClient: any = {
    $transaction: mock(async (callback: any) => {
      // Execute the callback with the mock prisma client itself
      // This allows transactions to use the same mocked methods
      return callback(mockPrismaClient);
    }),
    $queryRaw: mock(async (query: TemplateStringsArray, ...values: any[]) => {
      // Mock implementation for timeout query
      const queryStr = Array.from(query).join("");

      // Handle ApprovalQueue timeout query
      if (queryStr.includes("ApprovalQueue") && queryStr.includes("timeoutHours")) {
        const now = values[0] as Date;
        const results = Array.from(approvalQueueStore.values())
          .filter((approval) => {
            if (approval.status !== "PENDING") return false;
            if (!approval.timeoutHours) return false;

            // Calculate timeout
            const timeoutMs = approval.timeoutHours * 60 * 60 * 1000;
            const createdAtTime = new Date(approval.createdAt).getTime();
            const timeoutDate = new Date(createdAtTime + timeoutMs);

            return timeoutDate <= now;
          })
          .map((a) => ({
            id: a.id,
            requestId: a.requestId,
            autoAction: a.autoAction,
            timeoutHours: a.timeoutHours,
            createdAt: a.createdAt,
          }));

        return results;
      }

      return [];
    }),
    setting: {
      findUnique: mock(async ({ where }: { where: { key: string } }) => {
        return settingStore.get(where.key) || null;
      }),
      findMany: mock(
        async (args?: { select?: { key: boolean }; where?: { key?: { startsWith: string } } }) => {
          let results = Array.from(settingStore.values());

          if (args?.where?.key?.startsWith) {
            const prefix = args.where.key.startsWith;
            results = results.filter((r) => r.key.startsWith(prefix));
          }

          return results;
        }
      ),
      upsert: mock(
        async ({
          where,
          create,
          update,
        }: {
          where: { key: string };
          create: { key: string; value: string };
          update: { value: string };
        }) => {
          const existing = settingStore.get(where.key);
          const record = {
            key: where.key,
            value: existing ? update.value : create.value,
            updatedAt: new Date(),
          };
          settingStore.set(where.key, record);
          return record;
        }
      ),
      delete: mock(async ({ where }: { where: { key: string } }) => {
        const record = settingStore.get(where.key);
        settingStore.delete(where.key);
        return record;
      }),
      count: mock(async () => settingStore.size),
    },
    mediaRequest: {
      create: mock(async ({ data }: { data: any }) => {
        const id = data.id || generateId();
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        mediaRequestStore.set(id, record);
        return record;
      }),
      findUnique: mock(async ({ where }: { where: { id: string } }) => {
        return mediaRequestStore.get(where.id) || null;
      }),
      findFirst: mock(async ({ where }: { where: any }) => {
        const values = Array.from(mediaRequestStore.values());
        return (
          values.find((v) => !where || Object.keys(where).every((k) => v[k] === where[k])) || null
        );
      }),
      findMany: mock(async ({ where }: { where?: any } = {}) => {
        let results = Array.from(mediaRequestStore.values());
        if (where) {
          results = results.filter((r) => {
            if (where.id?.startsWith) {
              return r.id?.startsWith(where.id.startsWith);
            }
            return Object.keys(where).every((k) => r[k] === where[k]);
          });
        }
        return results;
      }),
      update: mock(async ({ where, data }: { where: { id: string }; data: any }) => {
        const record = mediaRequestStore.get(where.id);
        if (!record) throw new Error(`MediaRequest with id ${where.id} not found`);
        const updated = { ...record, ...data, updatedAt: new Date() };
        mediaRequestStore.set(where.id, updated);
        return updated;
      }),
      deleteMany: mock(async ({ where }: { where?: any } = {}) => {
        let count = 0;
        if (where?.id?.startsWith) {
          Array.from(mediaRequestStore.entries()).forEach(([id, _record]) => {
            if (id.startsWith(where.id.startsWith)) {
              mediaRequestStore.delete(id);
              count++;
            }
          });
        } else {
          count = mediaRequestStore.size;
          mediaRequestStore.clear();
        }
        return { count };
      }),
    },
    pipelineTemplate: {
      create: mock(async ({ data }: { data: any }) => {
        const id = generateId();
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        pipelineTemplateStore.set(id, record);
        return record;
      }),
      findUnique: mock(async ({ where }: { where: { id: string } }) => {
        return pipelineTemplateStore.get(where.id) || null;
      }),
      deleteMany: mock(async () => {
        const count = pipelineTemplateStore.size;
        pipelineTemplateStore.clear();
        return { count };
      }),
    },
    pipelineExecution: {
      create: mock(async ({ data }: { data: any }) => {
        const id = generateId();
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        pipelineExecutionStore.set(id, record);
        return record;
      }),
      findUnique: mock(async ({ where }: { where: { id: string } }) => {
        return pipelineExecutionStore.get(where.id) || null;
      }),
      findFirst: mock(
        async ({ where, orderBy, select }: { where?: any; orderBy?: any; select?: any } = {}) => {
          let values = Array.from(pipelineExecutionStore.values());

          // Apply where filter
          if (where) {
            values = values.filter((v) =>
              Object.keys(where).every((k) => {
                if (k === "parentExecutionId" && where[k] === null) {
                  return v[k] === null || v[k] === undefined;
                }
                return v[k] === where[k];
              })
            );
          }

          // Apply orderBy
          if (orderBy?.startedAt === "desc") {
            values.sort(
              (a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime()
            );
          }

          const result = values[0] || null;

          // Apply select
          if (result && select) {
            const selectedFields: any = {};
            for (const key of Object.keys(select)) {
              if (select[key]) {
                selectedFields[key] = result[key];
              }
            }
            return selectedFields;
          }

          return result;
        }
      ),
      update: mock(async ({ where, data }: { where: { id: string }; data: any }) => {
        const record = pipelineExecutionStore.get(where.id);
        if (!record) return null;
        const updated = { ...record, ...data, updatedAt: new Date() };
        pipelineExecutionStore.set(where.id, updated);
        return updated;
      }),
      updateMany: mock(async ({ where, data }: { where: any; data: any }) => {
        let count = 0;
        for (const [id, record] of pipelineExecutionStore.entries()) {
          const matches = Object.keys(where).every((key) => {
            if (key === "status" && typeof where[key] === "string") {
              return record[key] === where[key];
            }
            return record[key] === where[key];
          });
          if (matches) {
            const updated = { ...record, ...data, updatedAt: new Date() };
            pipelineExecutionStore.set(id, updated);
            count++;
          }
        }
        return { count };
      }),
      deleteMany: mock(async () => {
        const count = pipelineExecutionStore.size;
        pipelineExecutionStore.clear();
        return { count };
      }),
    },
    processingItem: {
      findUnique: mock(async ({ where }: { where: { id: string } }) => {
        return processingItemStore.get(where.id) || null;
      }),
      findMany: mock(async ({ where }: { where?: any } = {}) => {
        const values = Array.from(processingItemStore.values());
        if (!where) return values;

        return values.filter((v) =>
          Object.keys(where).every((key) => {
            if (key === "requestId") return v.requestId === where.requestId;
            if (key === "status" && where.status?.notIn) {
              return !where.status.notIn.includes(v.status);
            }
            if (key === "type") return v.type === where.type;
            return v[key] === where[key];
          })
        );
      }),
      count: mock(async ({ where }: { where?: any } = {}) => {
        const values = Array.from(processingItemStore.values());
        if (!where) return values.length;

        return values.filter((v) =>
          Object.keys(where).every((key) => {
            if (key === "requestId") return v.requestId === where.requestId;
            if (key === "type") return v.type === where.type;
            if (key === "status" && where.status?.notIn) {
              return !where.status.notIn.includes(v.status);
            }
            return v[key] === where[key];
          })
        ).length;
      }),
      updateMany: mock(async ({ where, data }: { where: any; data: any }) => {
        let count = 0;
        for (const [id, record] of processingItemStore.entries()) {
          const matches = Object.keys(where).every((key) => {
            if (key === "requestId") return record.requestId === where.requestId;
            if (key === "status" && where.status?.notIn) {
              return !where.status.notIn.includes(record.status);
            }
            return record[key] === where[key];
          });
          if (matches) {
            const updated = { ...record, ...data, updatedAt: new Date() };
            processingItemStore.set(id, updated);
            count++;
          }
        }
        return { count };
      }),
    },
    stepExecution: {
      create: mock(async ({ data }: { data: any }) => {
        const id = generateId();
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        stepExecutionStore.set(id, record);
        return record;
      }),
      deleteMany: mock(async () => {
        const count = stepExecutionStore.size;
        stepExecutionStore.clear();
        return { count };
      }),
    },
    notificationConfig: {
      create: mock(async ({ data }: { data: any }) => {
        const id = generateId();
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        notificationConfigStore.set(id, record);
        return record;
      }),
      findUnique: mock(async ({ where }: { where: { id: string } }) => {
        return notificationConfigStore.get(where.id) || null;
      }),
      findMany: mock(async ({ where }: { where?: any } = {}) => {
        let results = Array.from(notificationConfigStore.values());
        if (where) {
          results = results.filter((r) => {
            // Filter by enabled
            if (where.enabled !== undefined && r.enabled !== where.enabled) return false;

            // Filter by events array (has operator)
            if (where.events?.has) {
              if (!Array.isArray(r.events) || !r.events.includes(where.events.has)) return false;
            }

            // Handle OR condition for mediaType
            if (where.OR) {
              const matchesOr = where.OR.some((condition: any) => {
                if (condition.mediaType === null)
                  return r.mediaType === null || r.mediaType === undefined;
                if (condition.mediaType !== undefined) return r.mediaType === condition.mediaType;
                return true;
              });
              if (!matchesOr) return false;
            }

            // Filter by userId
            // When userId is in the where clause, match that specific userId
            // When userId is NOT in the where clause, match only null/undefined userId (global configs)
            const hasUserIdInWhere = "userId" in where;
            if (hasUserIdInWhere) {
              if (r.userId !== where.userId) return false;
            } else {
              // No userId in where clause means match only global configs (userId: null or undefined)
              if (r.userId !== null && r.userId !== undefined) return false;
            }

            return true;
          });
        }
        return results;
      }),
      deleteMany: mock(async () => {
        const count = notificationConfigStore.size;
        notificationConfigStore.clear();
        return { count };
      }),
    },
    activityLog: {
      create: mock(async ({ data }: { data: any }) => {
        const id = generateId();
        const record = { id, ...data, createdAt: new Date() };
        activityLogStore.set(id, record);
        return record;
      }),
      findMany: mock(async ({ where }: { where?: any } = {}) => {
        let results = Array.from(activityLogStore.values());
        if (where) {
          results = results.filter((r) => Object.keys(where).every((k) => r[k] === where[k]));
        }
        return results;
      }),
      deleteMany: mock(async () => {
        const count = activityLogStore.size;
        activityLogStore.clear();
        return { count };
      }),
    },
    approvalQueue: {
      create: mock(async ({ data }: { data: any }) => {
        const id = generateId();
        const record = {
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          processedAt: null,
          processedBy: null,
          comment: null,
          ...data, // Spread data AFTER defaults so it can override them
        };
        approvalQueueStore.set(id, record);
        return record;
      }),
      findUnique: mock(async ({ where }: { where: { id: string } }) => {
        return approvalQueueStore.get(where.id) || null;
      }),
      findMany: mock(async ({ where, include }: { where?: any; include?: any } = {}) => {
        let results = Array.from(approvalQueueStore.values());
        if (where) {
          results = results.filter((r) => {
            if (where.status && r.status !== where.status) return false;

            // Handle requiredRole filtering
            if (where.requiredRole) {
              if (typeof where.requiredRole === "string") {
                // Exact match
                if (r.requiredRole !== where.requiredRole) return false;
              } else if (where.requiredRole.in) {
                // IN operator
                if (!where.requiredRole.in.includes(r.requiredRole)) return false;
              }
            }

            if (where.AND) {
              return where.AND.every((condition: any) => {
                if (condition.createdAt?.lte) {
                  return new Date(r.createdAt) <= new Date(condition.createdAt.lte);
                }
                if (condition.timeoutHours?.not) {
                  return r.timeoutHours !== condition.timeoutHours.not;
                }
                return true;
              });
            }
            return true;
          });
        }
        if (include?.request) {
          results = results.map((r) => ({
            ...r,
            request: mediaRequestStore.get(r.requestId) || null,
          }));
        }
        return results;
      }),
      update: mock(async ({ where, data }: { where: { id: string }; data: any }) => {
        const record = approvalQueueStore.get(where.id);
        if (!record) return null;
        const updated = { ...record, ...data, updatedAt: new Date() };
        approvalQueueStore.set(where.id, updated);
        return updated;
      }),
      updateMany: mock(async ({ where, data }: { where: any; data: any }) => {
        let count = 0;
        Array.from(approvalQueueStore.values()).forEach((r) => {
          const matches = Object.keys(where).every((k) => {
            if (k === "id" && where.id.in) return where.id.in.includes(r.id);
            return r[k] === where[k];
          });
          if (matches) {
            const updated = { ...r, ...data, updatedAt: new Date() };
            approvalQueueStore.set(r.id, updated);
            count++;
          }
        });
        return { count };
      }),
      deleteMany: mock(async () => {
        const count = approvalQueueStore.size;
        approvalQueueStore.clear();
        return { count };
      }),
    },
    storageServer: {
      create: mock(async ({ data }: { data: any }) => {
        const id = data.id || generateId();
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        storageServerStore.set(id, record);
        return record;
      }),
      findUnique: mock(async ({ where }: { where: { id: string } }) => {
        return storageServerStore.get(where.id) || null;
      }),
      findMany: mock(async ({ where, select }: { where?: any; select?: any } = {}) => {
        let results = Array.from(storageServerStore.values());
        if (where?.id?.in) {
          results = results.filter((r) => where.id.in.includes(r.id));
        }
        if (select) {
          results = results.map((r: any) => {
            const selected: any = {};
            Object.keys(select).forEach((key) => {
              if (select[key]) selected[key] = r[key];
            });
            return selected;
          });
        }
        return results;
      }),
      deleteMany: mock(async () => {
        const count = storageServerStore.size;
        storageServerStore.clear();
        return { count };
      }),
    },
    tvEpisode: {
      create: mock(async ({ data }: { data: any }) => {
        const id = generateId();
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        tvEpisodeStore.set(id, record);
        return record;
      }),
      deleteMany: mock(async () => {
        const count = tvEpisodeStore.size;
        tvEpisodeStore.clear();
        return { count };
      }),
    },
    episodeLibraryItem: {
      findMany: mock(async ({ where }: { where?: any } = {}) => {
        const values = Array.from(episodeLibraryItemStore.values());
        if (!where) return values;

        return values.filter((v) =>
          Object.keys(where).every((key) => {
            if (key === "tmdbId") return v.tmdbId === where.tmdbId;
            if (key === "season") return v.season === where.season;
            if (key === "episode") return v.episode === where.episode;
            if (key === "serverId" && where.serverId?.in) {
              return where.serverId.in.includes(v.serverId);
            }
            return v[key] === where[key];
          })
        );
      }),
      deleteMany: mock(async () => {
        const count = episodeLibraryItemStore.size;
        episodeLibraryItemStore.clear();
        return { count };
      }),
    },
    download: {
      create: mock(async ({ data }: { data: any }) => {
        const id = generateId();
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        downloadStore.set(id, record);
        return record;
      }),
      deleteMany: mock(async () => {
        const count = downloadStore.size;
        downloadStore.clear();
        return { count };
      }),
    },
    mediaItem: {
      findUnique: mock(async ({ where }: { where: { id: string } }) => {
        return mediaItemStore.get(where.id) || null;
      }),
      create: mock(async ({ data }: { data: any }) => {
        const id = data.id || generateId();
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        mediaItemStore.set(id, record);
        return record;
      }),
      upsert: mock(
        async ({ where, create, update }: { where: { id: string }; create: any; update: any }) => {
          const existing = mediaItemStore.get(where.id);
          const record = existing
            ? { ...existing, ...update, updatedAt: new Date() }
            : { id: where.id, ...create, createdAt: new Date(), updatedAt: new Date() };
          mediaItemStore.set(where.id, record);
          return record;
        }
      ),
      deleteMany: mock(async () => {
        const count = mediaItemStore.size;
        mediaItemStore.clear();
        return { count };
      }),
    },
    indexer: {
      create: mock(async ({ data }: { data: any }) => {
        const id = data.id || generateId();
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        indexerStore.set(id, record);
        return record;
      }),
      findUnique: mock(async ({ where }: { where: { id: string } }) => {
        return indexerStore.get(where.id) || null;
      }),
      findFirst: mock(async ({ where }: { where?: any } = {}) => {
        const results = Array.from(indexerStore.values());
        if (where?.type && where?.apiKey) {
          return (
            results.find((r: any) => r.type === where.type && r.apiKey === where.apiKey) || null
          );
        }
        if (where?.type) {
          return results.find((r: any) => r.type === where.type) || null;
        }
        return results[0] || null;
      }),
      findMany: mock(async ({ where }: { where?: any } = {}) => {
        let results = Array.from(indexerStore.values());
        if (where?.type) {
          results = results.filter((r) => r.type === where.type);
        }
        return results;
      }),
      update: mock(async ({ where, data }: { where: { id: string }; data: any }) => {
        const record = indexerStore.get(where.id);
        if (!record) throw new Error(`Indexer with id ${where.id} not found`);
        const updated = { ...record, ...data, updatedAt: new Date() };
        indexerStore.set(where.id, updated);
        return updated;
      }),
      delete: mock(async ({ where }: { where: { id: string } }) => {
        const record = indexerStore.get(where.id);
        if (!record) throw new Error(`Indexer with id ${where.id} not found`);
        indexerStore.delete(where.id);
        return record;
      }),
      deleteMany: mock(async ({ where }: { where?: any } = {}) => {
        let count = 0;
        if (where?.type) {
          Array.from(indexerStore.entries()).forEach(([id, record]) => {
            if (record.type === where.type) {
              indexerStore.delete(id);
              count++;
            }
          });
        } else {
          count = indexerStore.size;
          indexerStore.clear();
        }
        return { count };
      }),
    },
    cardigannIndexer: {
      create: mock(async ({ data }: { data: any }) => {
        const id = data.id || generateId();
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        cardigannIndexerStore.set(id, record);
        return record;
      }),
      findUnique: mock(async ({ where }: { where: { id: string } }) => {
        return cardigannIndexerStore.get(where.id) || null;
      }),
      findMany: mock(async ({ orderBy }: { orderBy?: any } = {}) => {
        const results = Array.from(cardigannIndexerStore.values());
        // Simple ordering support (not perfect but works for tests)
        if (orderBy) {
          results.sort((a: any, b: any) => {
            for (const order of Array.isArray(orderBy) ? orderBy : [orderBy]) {
              const [key, direction] = Object.entries(order)[0] as [string, string];
              if (a[key] !== b[key]) {
                const comparison = a[key] > b[key] ? 1 : -1;
                return direction === "desc" ? -comparison : comparison;
              }
            }
            return 0;
          });
        }
        return results;
      }),
      update: mock(async ({ where, data }: { where: { id: string }; data: any }) => {
        const record = cardigannIndexerStore.get(where.id);
        if (!record) throw new Error(`CardigannIndexer with id ${where.id} not found`);
        const updated = { ...record, ...data, updatedAt: new Date() };
        cardigannIndexerStore.set(where.id, updated);
        return updated;
      }),
      delete: mock(async ({ where }: { where: { id: string } }) => {
        const record = cardigannIndexerStore.get(where.id);
        if (!record) throw new Error(`CardigannIndexer with id ${where.id} not found`);
        cardigannIndexerStore.delete(where.id);
        // Also delete associated rate limit requests (cascade)
        const rateLimitStore = cardigannIndexerRateLimitRequestStore;
        for (const [id, req] of rateLimitStore.entries()) {
          if (req.indexerId === where.id) {
            rateLimitStore.delete(id);
          }
        }
        return record;
      }),
      deleteMany: mock(async () => {
        const count = cardigannIndexerStore.size;
        cardigannIndexerStore.clear();
        return { count };
      }),
    },
    cardigannIndexerRateLimitRequest: {
      create: mock(async ({ data }: { data: any }) => {
        const id = data.id || generateId();
        const record = {
          id,
          ...data,
          requestedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        cardigannIndexerRateLimitRequestStore.set(id, record);
        return record;
      }),
      findMany: mock(async ({ where }: { where?: any } = {}) => {
        let results = Array.from(cardigannIndexerRateLimitRequestStore.values());
        if (where?.indexerId) {
          results = results.filter((r: any) => r.indexerId === where.indexerId);
        }
        return results;
      }),
      deleteMany: mock(async ({ where }: { where?: any } = {}) => {
        let count = 0;
        if (where?.indexerId) {
          for (const [id, req] of cardigannIndexerRateLimitRequestStore.entries()) {
            if (req.indexerId === where.indexerId) {
              cardigannIndexerRateLimitRequestStore.delete(id);
              count++;
            }
          }
        } else {
          count = cardigannIndexerRateLimitRequestStore.size;
          cardigannIndexerRateLimitRequestStore.clear();
        }
        return { count };
      }),
    },
    _stores: {
      setting: settingStore,
      mediaRequest: mediaRequestStore,
      pipelineTemplate: pipelineTemplateStore,
      pipelineExecution: pipelineExecutionStore,
      processingItem: processingItemStore,
      stepExecution: stepExecutionStore,
      notificationConfig: notificationConfigStore,
      activityLog: activityLogStore,
      approvalQueue: approvalQueueStore,
      storageServer: storageServerStore,
      tvEpisode: tvEpisodeStore,
      episodeLibraryItem: episodeLibraryItemStore,
      download: downloadStore,
      mediaItem: mediaItemStore,
      indexer: indexerStore,
      cardigannIndexer: cardigannIndexerStore,
      cardigannIndexerRateLimitRequest: cardigannIndexerRateLimitRequestStore,
    },
    _store: settingStore, // Backwards compatibility
    _clear: () => {
      settingStore.clear();
      mediaRequestStore.clear();
      pipelineTemplateStore.clear();
      pipelineExecutionStore.clear();
      processingItemStore.clear();
      stepExecutionStore.clear();
      notificationConfigStore.clear();
      activityLogStore.clear();
      approvalQueueStore.clear();
      storageServerStore.clear();
      tvEpisodeStore.clear();
      episodeLibraryItemStore.clear();
      downloadStore.clear();
      mediaItemStore.clear();
      indexerStore.clear();
      cardigannIndexerStore.clear();
      cardigannIndexerRateLimitRequestStore.clear();
    },
  };

  return mockPrismaClient;
}
