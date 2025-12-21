/**
 * Database Test Utilities - Helpers for managing test database state
 */

import { type MediaType, type Prisma, RequestStatus } from "@prisma/client";
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
}) {
  const targets = data.targets || [{ serverId: "test-server" }];

  return prisma.mediaRequest.create({
    data: {
      id: data.id || `test-request-${Date.now()}`,
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
}

/**
 * Create a test storage server
 */
export async function createTestServer(data?: {
  id?: string;
  name?: string;
  maxResolution?: "SD" | "HD" | "FULL_HD" | "UHD_4K";
}) {
  return prisma.storageServer.create({
    data: {
      id: data?.id || `test-server-${Date.now()}`,
      name: data?.name || "Test Server",
      host: "localhost",
      port: 22,
      protocol: "SFTP",
      username: "test",
      password: "test",
      moviePath: "/movies",
      tvPath: "/tv",
      maxResolution: data?.maxResolution || "UHD_4K",
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
