-- CreateEnum
CREATE TYPE "ProcessType" AS ENUM ('ENCODING', 'PROBE', 'DELIVERY', 'OTHER');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('ACTIVE', 'STOPPED', 'DEAD');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "estimatedEnd" TIMESTAMP(3),
ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "parentJobId" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "workerId" TEXT;

-- CreateTable
CREATE TABLE "TrackedProcess" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "command" TEXT NOT NULL,
    "args" TEXT[],
    "processType" "ProcessType" NOT NULL,
    "gpuDevice" TEXT,
    "inputFile" TEXT,
    "outputFile" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackedProcess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GpuAllocation" (
    "id" TEXT NOT NULL,
    "devicePath" TEXT NOT NULL,
    "jobId" TEXT,
    "activeCount" INTEGER NOT NULL DEFAULT 0,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
    "allocatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GpuAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "nodePid" INTEGER NOT NULL,
    "status" "WorkerStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackedProcess_jobId_idx" ON "TrackedProcess"("jobId");

-- CreateIndex
CREATE INDEX "TrackedProcess_pid_idx" ON "TrackedProcess"("pid");

-- CreateIndex
CREATE INDEX "TrackedProcess_processType_idx" ON "TrackedProcess"("processType");

-- CreateIndex
CREATE UNIQUE INDEX "GpuAllocation_devicePath_key" ON "GpuAllocation"("devicePath");

-- CreateIndex
CREATE UNIQUE INDEX "GpuAllocation_jobId_key" ON "GpuAllocation"("jobId");

-- CreateIndex
CREATE INDEX "GpuAllocation_devicePath_idx" ON "GpuAllocation"("devicePath");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_workerId_key" ON "Worker"("workerId");

-- CreateIndex
CREATE INDEX "Worker_status_lastHeartbeat_idx" ON "Worker"("status", "lastHeartbeat");

-- CreateIndex
CREATE INDEX "Job_workerId_status_idx" ON "Job"("workerId", "status");

-- CreateIndex
CREATE INDEX "Job_parentJobId_idx" ON "Job"("parentJobId");

-- CreateIndex
CREATE INDEX "Job_requestId_idx" ON "Job"("requestId");

-- CreateIndex
CREATE INDEX "Job_heartbeatAt_idx" ON "Job"("heartbeatAt");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_parentJobId_fkey" FOREIGN KEY ("parentJobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedProcess" ADD CONSTRAINT "TrackedProcess_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GpuAllocation" ADD CONSTRAINT "GpuAllocation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
