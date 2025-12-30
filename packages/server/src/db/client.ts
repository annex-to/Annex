import { PrismaClient } from "@prisma/client";

// Singleton pattern for Prisma client
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Configure connection pool via URL parameters
// Increase pool size and timeout to handle high-frequency updates from remote encoders
function getDatabaseUrl(): string {
  const baseUrl = process.env.DATABASE_URL || "";

  // Don't modify if already has connection params or if it's a connection string
  if (baseUrl.includes("connection_limit") || baseUrl.includes("pool_timeout")) {
    return baseUrl;
  }

  // Add connection pool configuration
  // connection_limit: max connections in pool (default is ~17)
  // pool_timeout: seconds to wait for connection before timing out (default is 10)
  // Set to 80 to leave headroom (PostgreSQL max_connections=100, need to reserve some for system)
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}connection_limit=80&pool_timeout=60`;
}

// Create base Prisma client
const basePrisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  datasources: {
    db: {
      url: getDatabaseUrl(),
    },
  },
});

// Add retry extension for engine connection errors
export const prisma =
  globalForPrisma.prisma ??
  basePrisma.$extends({
    query: {
      $allOperations: async ({ operation, model, args, query }) => {
        const maxRetries = 3;
        let retries = 0;

        while (retries < maxRetries) {
          try {
            return await query(args);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            // Retry on engine connection errors
            if (
              errorMessage.includes("Engine is not yet connected") ||
              errorMessage.includes("Can't reach database server")
            ) {
              retries++;
              if (retries >= maxRetries) {
                console.error(
                  `[Prisma] Max retries (${maxRetries}) exceeded for ${model}.${operation}`
                );
                throw error;
              }

              // Exponential backoff: 100ms, 200ms, 400ms
              const delay = Math.min(100 * 2 ** (retries - 1), 1000);
              console.warn(
                `[Prisma] Retry ${retries}/${maxRetries} for ${model}.${operation} after ${delay}ms`
              );
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            }

            // Don't retry other errors
            throw error;
          }
        }

        // Should never reach here
        throw new Error("Retry logic failed");
      },
    },
  });

// Always cache the instance globally to prevent multiple clients
globalForPrisma.prisma = prisma;

// Graceful shutdown
process.on("beforeExit", async () => {
  await prisma.$disconnect();
});

export { prisma as db };
