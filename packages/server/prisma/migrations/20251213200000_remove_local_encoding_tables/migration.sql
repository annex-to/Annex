-- Remove local encoding related tables
-- TrackedProcess was used for tracking spawned encoding processes for crash recovery
-- GpuAllocation was used for managing GPU semaphores for local encoding

-- Drop TrackedProcess table
DROP TABLE IF EXISTS "TrackedProcess";

-- Drop GpuAllocation table
DROP TABLE IF EXISTS "GpuAllocation";

-- Drop ProcessType enum (used by TrackedProcess)
DROP TYPE IF EXISTS "ProcessType";
