import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MediaType, type Prisma, ProcessingStatus, RequestStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import { pipelineOrchestrator } from "../../services/pipeline/PipelineOrchestrator.js";
import { requestStatusComputer } from "../../services/requestStatusComputer.js";

interface RequestTarget {
  serverId: string;
}

function formatServerList(servers: Array<{ id: string; name: string }>) {
  return servers.map((s: { id: string; name: string }) => ({
    id: s.id,
    name: s.name,
  }));
}

function getTargetServerIds(
  targetServers: Array<{ serverId: string }>,
  targets: unknown
): string[] {
  if (targetServers.length > 0) {
    return targetServers.map((t: { serverId: string }) => t.serverId);
  }
  const legacyTargets = targets as RequestTarget[] | null;
  if (Array.isArray(legacyTargets)) {
    return legacyTargets
      .filter((t: RequestTarget) => t?.serverId)
      .map((t: RequestTarget) => t.serverId);
  }
  return [];
}

function buildServerNameMap(servers: Array<{ id: string; name: string }>): Map<string, string> {
  return new Map(servers.map((s: { id: string; name: string }) => [s.id, s.name]));
}

export function registerRequestTools(server: McpServer, userId: string) {
  server.tool(
    "create_request",
    "Create a media request to download and deliver a movie or TV show to specified storage servers. The request enters the processing pipeline automatically.",
    {
      tmdbId: z.number().describe("TMDB ID of the media item"),
      type: z.enum(["movie", "tv"]).describe("Media type"),
      title: z.string().describe("Title of the media"),
      year: z.number().describe("Release year"),
      serverIds: z.array(z.string()).min(1).describe("Target storage server IDs to deliver to"),
      seasons: z
        .array(z.number())
        .optional()
        .describe("For TV: specific season numbers to request (omit for all)"),
    },
    async ({ tmdbId, type, title, year, serverIds, seasons }) => {
      const servers = await prisma.storageServer.findMany({
        where: { id: { in: serverIds }, enabled: true },
        select: { id: true, name: true },
      });

      if (servers.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No valid storage servers found for the provided IDs",
            },
          ],
          isError: true,
        };
      }

      const existing = await prisma.mediaRequest.findFirst({
        where: {
          tmdbId,
          type: type === "movie" ? MediaType.MOVIE : MediaType.TV,
          status: {
            notIn: [RequestStatus.COMPLETED, RequestStatus.FAILED, RequestStatus.CANCELLED],
          },
        },
      });

      if (existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "Active request already exists for this media",
                  existingRequestId: existing.id,
                  status: existing.status.toLowerCase(),
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      if (type === "movie") {
        const { requestId, items } = await pipelineOrchestrator.createRequest({
          type: "movie",
          tmdbId,
          title,
          year,
          targetServers: serverIds,
        });

        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            userId,
            targets: serverIds.map((sid: string) => ({
              serverId: sid,
            })) as unknown as Prisma.JsonArray,
          },
        });

        const result = {
          requestId,
          type: "movie",
          title,
          year,
          targetServers: formatServerList(servers),
          itemCount: items.length,
          status: "pending",
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // TV request
      const { requestId, items } = await pipelineOrchestrator.createRequest({
        type: "tv",
        tmdbId,
        title,
        year,
        targetServers: serverIds,
        episodes: [],
      });

      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          userId,
          requestedSeasons: seasons ?? [],
          targets: serverIds.map((sid: string) => ({
            serverId: sid,
          })) as unknown as Prisma.JsonArray,
        },
      });

      const result = {
        requestId,
        type: "tv",
        title,
        year,
        seasons: seasons ?? "all",
        targetServers: formatServerList(servers),
        itemCount: items.length,
        status: "pending",
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "list_requests",
    "List media requests with optional filtering by storage server, status, and media type.",
    {
      serverId: z.string().optional().describe("Filter by target storage server ID"),
      status: z
        .enum([
          "pending",
          "searching",
          "downloading",
          "encoding",
          "delivering",
          "completed",
          "failed",
        ])
        .optional()
        .describe("Filter by request status"),
      type: z.enum(["movie", "tv"]).optional().describe("Filter by media type"),
      page: z.number().min(1).default(1).describe("Page number"),
      limit: z.number().min(1).max(50).default(20).describe("Items per page"),
    },
    async ({ serverId, status, type, page = 1, limit = 20 }) => {
      const conditions: Prisma.MediaRequestWhereInput[] = [];

      if (status) {
        const statusMap: Record<string, RequestStatus> = {
          pending: RequestStatus.PENDING,
          searching: RequestStatus.SEARCHING,
          downloading: RequestStatus.DOWNLOADING,
          encoding: RequestStatus.ENCODING,
          delivering: RequestStatus.DELIVERING,
          completed: RequestStatus.COMPLETED,
          failed: RequestStatus.FAILED,
        };
        conditions.push({ status: statusMap[status] });
      }

      if (type) {
        conditions.push({
          type: type === "movie" ? MediaType.MOVIE : MediaType.TV,
        });
      }

      if (serverId) {
        conditions.push({
          targetServers: {
            some: { serverId },
          },
        });
      }

      const where: Prisma.MediaRequestWhereInput = conditions.length > 0 ? { AND: conditions } : {};

      const [requests, totalCount] = await Promise.all([
        prisma.mediaRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            targetServers: {
              select: { serverId: true },
            },
            processingItems: {
              select: {
                id: true,
                status: true,
                season: true,
                episode: true,
              },
            },
          },
        }),
        prisma.mediaRequest.count({ where }),
      ]);

      type RequestRow = (typeof requests)[number];

      // Collect all server IDs
      const allServerIds = new Set<string>();
      for (const req of requests) {
        for (const ts of req.targetServers) {
          allServerIds.add(ts.serverId);
        }
        const legacyTargets = req.targets as unknown as RequestTarget[];
        if (Array.isArray(legacyTargets)) {
          for (const lt of legacyTargets) {
            if (lt?.serverId) allServerIds.add(lt.serverId);
          }
        }
      }

      const serverRows = await prisma.storageServer.findMany({
        where: { id: { in: Array.from(allServerIds) } },
        select: { id: true, name: true },
      });
      const serverMap = buildServerNameMap(serverRows);

      const requestIds = requests.map((req: RequestRow) => req.id);
      const computedStatuses = await requestStatusComputer.batchComputeStatus(requestIds);

      const results = requests.map((req: RequestRow) => {
        const computed = computedStatuses.get(req.id);
        const targetIds = getTargetServerIds(req.targetServers, req.targets);

        return {
          id: req.id,
          type: req.type.toLowerCase(),
          tmdbId: req.tmdbId,
          title: req.title,
          year: req.year,
          status: computed ? computed.status.toLowerCase() : req.status.toLowerCase(),
          progress: computed?.progress ?? req.progress,
          error: computed?.error ?? req.error,
          targetServers: targetIds.map((sid: string) => ({
            id: sid,
            name: serverMap.get(sid) ?? "Unknown",
          })),
          totalItems: req.totalItems,
          completedItems: req.completedItems,
          failedItems: req.failedItems,
          createdAt: req.createdAt.toISOString(),
          completedAt: req.completedAt?.toISOString(),
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                page,
                totalPages: Math.ceil(totalCount / limit),
                totalItems: totalCount,
                requests: results,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_request",
    "Get full details of a specific media request including processing item statuses, progress, and errors.",
    {
      requestId: z.string().describe("Request ID"),
    },
    async ({ requestId }) => {
      const req = await prisma.mediaRequest.findUnique({
        where: { id: requestId },
        include: {
          targetServers: { select: { serverId: true } },
          processingItems: {
            select: {
              id: true,
              type: true,
              status: true,
              progress: true,
              season: true,
              episode: true,
              title: true,
              attempts: true,
              maxAttempts: true,
              lastError: true,
              currentStep: true,
              createdAt: true,
              completedAt: true,
            },
            orderBy: [{ season: "asc" }, { episode: "asc" }],
          },
        },
      });

      if (!req) {
        return {
          content: [{ type: "text" as const, text: "Request not found" }],
          isError: true,
        };
      }

      const targetIds = getTargetServerIds(req.targetServers, req.targets);

      const serverRows = await prisma.storageServer.findMany({
        where: { id: { in: targetIds } },
        select: { id: true, name: true },
      });
      const serverMap = buildServerNameMap(serverRows);

      const computed = await requestStatusComputer.computeStatus(requestId);

      type ProcItem = (typeof req.processingItems)[number];

      const result = {
        id: req.id,
        type: req.type.toLowerCase(),
        tmdbId: req.tmdbId,
        title: req.title,
        year: req.year,
        status: computed.status.toLowerCase(),
        progress: computed.progress,
        currentStep: computed.currentStep,
        error: computed.error,
        targetServers: targetIds.map((sid: string) => ({
          id: sid,
          name: serverMap.get(sid) ?? "Unknown",
        })),
        totalItems: req.totalItems,
        completedItems: req.completedItems,
        failedItems: req.failedItems,
        createdAt: req.createdAt.toISOString(),
        updatedAt: req.updatedAt.toISOString(),
        completedAt: req.completedAt?.toISOString(),
        processingItems: req.processingItems.map((item: ProcItem) => ({
          id: item.id,
          type: item.type.toLowerCase(),
          title: item.title,
          season: item.season,
          episode: item.episode,
          status: item.status.toLowerCase(),
          progress: item.progress,
          currentStep: item.currentStep,
          attempts: item.attempts,
          maxAttempts: item.maxAttempts,
          lastError: item.lastError,
          createdAt: item.createdAt.toISOString(),
          completedAt: item.completedAt?.toISOString(),
        })),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "cancel_request",
    "Cancel an active media request. Stops all processing items and encoding jobs.",
    {
      requestId: z.string().describe("Request ID to cancel"),
    },
    async ({ requestId }) => {
      const request = await prisma.mediaRequest.findUnique({
        where: { id: requestId },
        select: { id: true, title: true, status: true, userId: true },
      });

      if (!request) {
        return {
          content: [{ type: "text" as const, text: "Request not found" }],
          isError: true,
        };
      }

      if (
        request.status === RequestStatus.COMPLETED ||
        request.status === RequestStatus.CANCELLED
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Request is already ${request.status.toLowerCase()}`,
            },
          ],
          isError: true,
        };
      }

      await prisma.processingItem.updateMany({
        where: { requestId },
        data: {
          status: ProcessingStatus.CANCELLED,
          lastError: "Cancelled via MCP",
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { success: true, requestId, title: request.title, message: "Request cancelled" },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
