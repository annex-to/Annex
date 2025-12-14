-- CreateEnum
CREATE TYPE "EncoderStatus" AS ENUM ('OFFLINE', 'IDLE', 'ENCODING', 'ERROR');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('PENDING', 'ENCODING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "RemoteEncoder" (
    "id" TEXT NOT NULL,
    "encoderId" TEXT NOT NULL,
    "name" TEXT,
    "gpuDevice" TEXT NOT NULL,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
    "status" "EncoderStatus" NOT NULL DEFAULT 'OFFLINE',
    "currentJobs" INTEGER NOT NULL DEFAULT 0,
    "lastHeartbeat" TIMESTAMP(3),
    "totalJobsCompleted" INTEGER NOT NULL DEFAULT 0,
    "totalJobsFailed" INTEGER NOT NULL DEFAULT 0,
    "avgEncodingSpeed" DOUBLE PRECISION,
    "hostname" TEXT,
    "version" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemoteEncoder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EncoderAssignment" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "encoderId" TEXT NOT NULL,
    "inputPath" TEXT NOT NULL,
    "outputPath" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "error" TEXT,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fps" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "eta" INTEGER,
    "outputSize" BIGINT,
    "compressionRatio" DOUBLE PRECISION,
    "encodeDuration" DOUBLE PRECISION,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EncoderAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RemoteEncoder_encoderId_key" ON "RemoteEncoder"("encoderId");

-- CreateIndex
CREATE INDEX "RemoteEncoder_status_currentJobs_idx" ON "RemoteEncoder"("status", "currentJobs");

-- CreateIndex
CREATE UNIQUE INDEX "EncoderAssignment_jobId_key" ON "EncoderAssignment"("jobId");

-- CreateIndex
CREATE INDEX "EncoderAssignment_status_idx" ON "EncoderAssignment"("status");

-- CreateIndex
CREATE INDEX "EncoderAssignment_encoderId_status_idx" ON "EncoderAssignment"("encoderId", "status");

-- AddForeignKey
ALTER TABLE "EncoderAssignment" ADD CONSTRAINT "EncoderAssignment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EncoderAssignment" ADD CONSTRAINT "EncoderAssignment_encoderId_fkey" FOREIGN KEY ("encoderId") REFERENCES "RemoteEncoder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
