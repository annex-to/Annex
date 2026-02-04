import { z } from "zod";
import { prisma } from "../db/client.js";
import { protectedProcedure, router } from "../trpc.js";

function generateRawToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashToken(rawToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(rawToken);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const mcpRouter = router({
  createToken: protectedProcedure
    .input(
      z.object({
        name: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const rawToken = generateRawToken();
      const tokenHash = await hashToken(rawToken);

      const mcpToken = await prisma.mcpToken.create({
        data: {
          token: tokenHash,
          name: input.name || null,
          userId: ctx.user.id,
        },
      });

      // Build the MCP URL
      const protocol = "http";
      const host = ctx.config.server.host === "0.0.0.0" ? "localhost" : ctx.config.server.host;
      const port = ctx.config.server.port;
      const mcpUrl = `${protocol}://${host}:${port}/mcp?token=${rawToken}`;

      return {
        id: mcpToken.id,
        name: mcpToken.name,
        rawToken,
        mcpUrl,
        createdAt: mcpToken.createdAt,
      };
    }),

  listTokens: protectedProcedure.query(async ({ ctx }) => {
    const tokens = await prisma.mcpToken.findMany({
      where: { userId: ctx.user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    return tokens;
  }),

  deleteToken: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify the token belongs to the user
      const token = await prisma.mcpToken.findUnique({
        where: { id: input.id },
        select: { userId: true },
      });

      if (!token || token.userId !== ctx.user.id) {
        throw new Error("Token not found");
      }

      await prisma.mcpToken.delete({
        where: { id: input.id },
      });

      return { success: true };
    }),
});
