/**
 * Pipeline Test Utilities - Centralized exports for easy importing
 */

// Fixtures
export { MOVIES, TARGETS, TV_SHOWS } from "./fixtures/media.js";
export {
  createReleaseSet,
  EDGE_CASE_RELEASES,
  MOVIE_RELEASES,
  TV_EPISODE_RELEASES,
  TV_SEASON_RELEASES,
} from "./fixtures/releases.js";
export { createMockTorrent, MockDownloadManager } from "./mocks/downloadManager.mock.js";

// Mocks
export {
  createMockRelease,
  createQualityVariants,
  MockIndexerService,
} from "./mocks/indexer.mock.js";
export {
  assertNextStep,
  assertStepData,
  assertStepFailure,
  assertStepPaused,
  assertStepRetry,
  assertStepSkipped,
  assertStepSuccess,
} from "./test-utils/assertions.js";
// Test Utilities
export { ContextBuilder } from "./test-utils/context-builder.js";
export {
  cleanupTestData,
  createTestRequest,
  createTestServer,
  getActivityLogs,
  getRequestStatus,
} from "./test-utils/database.js";
