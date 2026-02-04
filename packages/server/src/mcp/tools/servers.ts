import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MediaType } from "@prisma/client";
import { prisma } from "../../db/client.js";

export function registerServerTools(server: McpServer) {
  server.tool(
    "list_servers",
    "List all storage servers with their media server configuration and library item counts",
    {},
    async () => {
      const servers = await prisma.storageServer.findMany({
        where: { enabled: true },
        orderBy: { name: "asc" },
      });

      type ServerRow = (typeof servers)[number];
      const serverIds = servers.map((s: ServerRow) => s.id);

      const counts = await prisma.libraryItem.groupBy({
        by: ["serverId", "type"],
        where: { serverId: { in: serverIds } },
        _count: { id: true },
      });

      const countMap = new Map<string, { movies: number; tv: number }>();
      for (const c of counts) {
        const existing = countMap.get(c.serverId) ?? { movies: 0, tv: 0 };
        if (c.type === MediaType.MOVIE) {
          existing.movies = c._count.id;
        } else {
          existing.tv = c._count.id;
        }
        countMap.set(c.serverId, existing);
      }

      const results = servers.map((s: ServerRow) => {
        const libraryCounts = countMap.get(s.id) ?? { movies: 0, tv: 0 };
        return {
          id: s.id,
          name: s.name,
          mediaServerType: s.mediaServerType.toLowerCase(),
          mediaServerUrl: s.mediaServerUrl,
          library: {
            movies: libraryCounts.movies,
            tvShows: libraryCounts.tv,
            total: libraryCounts.movies + libraryCounts.tv,
          },
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );
}
