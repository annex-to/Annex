/**
 * Database Test Utilities - Helpers for managing test database state
 */

import {
	type ExecutionStatus,
	type MediaType,
	type Prisma,
	RequestStatus,
	type Resolution,
} from "@prisma/client";
import { prisma } from "../../../../db/client.js";

/**
 * Clean up all test data
 */
export async function cleanupTestData(): Promise<void> {
  // Delete in correct order due to foreign key constraints
  await prisma.activityLog.deleteMany({});
  await prisma.stepExecution.deleteMany({});
  await prisma.pipelineExecution.deleteMany({});
  await prisma.tvEpisode.deleteMany({});
  await prisma.download.deleteMany({});
  await prisma.mediaRequest.deleteMany({
    where: { id: { startsWith: "test-" } },
  });
}

/**
 * Create a test media request
 */
export async function createTestRequest(data: {
  id?: string;
  type: MediaType;
  tmdbId: number;
  title: string;
  year: number;
  requestedSeasons?: number[] | null;
  requestedEpisodes?: Array<{ season: number; episode: number }> | null;
  targets?: Array<{ serverId: string; encodingProfileId?: string }>;
  status?: RequestStatus;
  createExecution?: boolean; // Create a parent pipeline execution for this request
}) {
  const targets = data.targets || [{ serverId: "test-server" }];
  const requestId = data.id || `test-request-${Date.now()}`;

  const request = await prisma.mediaRequest.create({
    data: {
      id: requestId,
      type: data.type,
      tmdbId: data.tmdbId,
      title: data.title,
      year: data.year,
      requestedSeasons: data.requestedSeasons ?? undefined,
      requestedEpisodes: (data.requestedEpisodes ?? undefined) as Prisma.InputJsonValue,
      targets: targets as Prisma.InputJsonValue,
      status: data.status || RequestStatus.PENDING,
      progress: 0,
    },
  });

  // Create a parent pipeline execution if requested (needed for SearchStep tests)
  if (data.createExecution) {
    await prisma.pipelineExecution.create({
      data: {
        requestId,
        templateId: "test-template",
        status: "RUNNING" as ExecutionStatus,
        currentStep: 0,
        steps: [],
        context: {},
        startedAt: new Date(),
      },
    });
  }

  return request;
}

/**
 * Create a test storage server
 */
export async function createTestServer(data?: {
  id?: string;
  name?: string;
  maxResolution?: Resolution;
}) {
  return prisma.storageServer.create({
    data: {
      id: data?.id || `test-server-${Date.now()}`,
      name: data?.name || "Test Server",
      host: "localhost",
      port: 22,
      protocol: "SFTP",
      username: "test",
      encryptedPassword: "test",
      pathMovies: "/movies",
      pathTv: "/tv",
      maxResolution: data?.maxResolution || "RES_4K",
      preferredCodec: "AV1",
      enabled: true,
    },
  });
}

/**
 * Get all activity logs for a request
 */
export async function getActivityLogs(requestId: string) {
  return prisma.activityLog.findMany({
    where: { requestId },
    orderBy: { id: "asc" },
  });
}

/**
 * Get the latest status of a request
 */
export async function getRequestStatus(requestId: string) {
  return prisma.mediaRequest.findUnique({
    where: { id: requestId },
    select: {
      status: true,
      progress: true,
      currentStep: true,
      error: true,
    },
  });
}
