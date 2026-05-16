import { prisma } from "../../../db/client";
import { mapDownloadFiles } from "../../fileMapping";

const MAX_ATTEMPTS = 3;

export class FileMapWorker {
  readonly name = "FileMapWorker";

  async processBatch(): Promise<void> {
    const pending = await prisma.download.findMany({
      where: {
        fileMapStatus: "PENDING",
        status: "COMPLETED",
        mapAttempts: { lt: MAX_ATTEMPTS },
      },
      orderBy: { updatedAt: "asc" },
      take: 10,
      select: { id: true },
    });

    for (const { id } of pending) {
      try {
        await prisma.download.update({
          where: { id },
          data: { mapAttempts: { increment: 1 } },
        });
        await mapDownloadFiles(id);
      } catch (error) {
        console.error(`[${this.name}] Failed to map files for download ${id}:`, error);
        const current = await prisma.download.findUnique({
          where: { id },
          select: { mapAttempts: true },
        });
        if (current && current.mapAttempts >= MAX_ATTEMPTS) {
          await prisma.download.update({
            where: { id },
            data: { fileMapStatus: "FAILED" },
          });
        } else {
          await prisma.download.update({
            where: { id },
            data: { fileMapStatus: "PENDING" },
          });
        }
      }
    }
  }
}

export const fileMapWorker = new FileMapWorker();
