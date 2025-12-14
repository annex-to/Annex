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
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}connection_limit=30&pool_timeout=30`;
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasources: {
      db: {
        url: getDatabaseUrl(),
      },
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Graceful shutdown
process.on("beforeExit", async () => {
  await prisma.$disconnect();
});

export { prisma as db };
