# Pipeline System

The Annex pipeline system provides customizable, visual workflow orchestration for media requests. Pipelines define the steps required to process media from discovery to delivery.

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
- [Pipeline Templates](#pipeline-templates)
- [Step Types](#step-types)
- [Parallel Execution](#parallel-execution)
- [Creating Pipelines](#creating-pipelines)
- [Managing Executions](#managing-executions)
- [Migration from Legacy](#migration-from-legacy)
- [Development Guide](#development-guide)

## Overview

The pipeline system replaces the legacy hardcoded movie/TV pipelines with a flexible, template-based approach. Key features:

- **Visual Editor**: Drag-and-drop interface for pipeline design (React Flow)
- **Parallel Execution**: Branch pipelines to run independent steps concurrently
- **Extensible**: Easy to add custom step types
- **Resume Support**: Pause/resume pipelines for approval workflows
- **Error Handling**: Per-step retry and error continuation policies

## Core Concepts

### Pipeline Template

A reusable workflow definition that specifies:
- Media type (Movie or TV)
- Sequence of steps to execute
- Configuration for each step
- Visual layout for the editor

### Pipeline Execution

A specific instance of a pipeline template running for a media request:
- Tracks current step and overall status
- Stores accumulated context shared between steps
- Records step-by-step execution history

### Step

An atomic unit of work in a pipeline:
- **Type**: Determines the step's behavior (SEARCH, DOWNLOAD, ENCODE, etc.)
- **Config**: Step-specific settings (timeouts, quality, etc.)
- **Context**: Shared data passed between steps
- **Behavior Flags**:
  - `required`: Pipeline fails if this step fails
  - `retryable`: Allow manual retry on failure
  - `continueOnError`: Don't halt pipeline on failure

### Pipeline Context

A JSON object that accumulates data as the pipeline progresses:

```typescript
interface PipelineContext {
  requestId: string;
  mediaType: "MOVIE" | "TV";
  tmdbId: number;
  title: string;
  year: number;
  targets: Array<{ serverId: string; encodingProfileId?: string }>;

  // Step outputs (accumulated as pipeline progresses)
  search?: { torrentId: string; magnetUri: string; ... };
  download?: { sourceFilePath: string; ... };
  encode?: { outputPath: string; jobId: string; ... };
  deliver?: { delivered: boolean; ... };
}
```

## Pipeline Templates

### Database Schema

```prisma
model PipelineTemplate {
  id          String   @id @default(cuid())
  name        String
  description String?
  mediaType   MediaType
  isDefault   Boolean  @default(false)
  isPublic    Boolean  @default(true)
  userId      String?  // Owner (null = system template)

  steps       Json     // Tree structure with children
  layout      Json?    // Visual editor layout

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  executions  PipelineExecution[]
}
```

### Step Tree Structure

Steps are stored as a tree to support parallel execution:

```json
{
  "steps": [
    {
      "type": "SEARCH",
      "name": "Find torrent",
      "config": { "minSeeds": 5, "timeoutSeconds": 300 },
      "required": true,
      "retryable": true,
      "continueOnError": false,
      "children": [
        {
          "type": "DOWNLOAD",
          "name": "Download source",
          "config": { "maxDownloadHours": 24 },
          "children": [
            {
              "type": "ENCODE",
              "name": "Encode to AV1",
              "config": { "crf": 28, "maxResolution": "1080p" },
              "children": [
                {
                  "type": "DELIVER",
                  "name": "Deliver to Plex",
                  "config": { "verifyDelivery": true }
                },
                {
                  "type": "NOTIFICATION",
                  "name": "Send completion notification",
                  "config": { "event": "REQUEST_COMPLETED" }
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

## Step Types

### SEARCH

Find and select a torrent/NZB release for the media.

**Config:**
```typescript
interface SearchStepConfig {
  minSeeds?: number;           // Minimum seeders (default: 1)
  timeoutSeconds?: number;      // Search timeout (default: 300)
}
```

**Outputs:**
```typescript
{
  search: {
    torrentId: string;
    magnetUri: string;
    title: string;
    size: number;
    seeders: number;
  }
}
```

### DOWNLOAD

Download the source media file via qBittorrent.

**Config:**
```typescript
interface DownloadStepConfig {
  maxDownloadHours?: number;    // Download timeout (default: 24)
  pollInterval?: number;        // Status check interval (default: 10000ms)
}
```

**Outputs:**
```typescript
{
  download: {
    sourceFilePath: string;
    downloadedAt: string;
    fileSize: number;
  }
}
```

### ENCODE

Encode video to AV1 using remote encoders.

**Config:**
```typescript
interface EncodeStepConfig {
  crf?: number;                 // Quality 0-51 (lower = better, default: 28)
  maxResolution?: "480p" | "720p" | "1080p" | "2160p";
  preset?: "fast" | "medium" | "slow";
  pollInterval?: number;        // Progress check interval (default: 5000ms)
  timeout?: number;             // Encoding timeout (default: 12 hours)
}
```

**Outputs:**
```typescript
{
  encode: {
    jobId: string;
    assignmentId: string;
    outputPath: string;
    encodedAt: string;
    duration: number;
    outputSize?: number;
    compressionRatio?: number;
  }
}
```

### DELIVER

Copy encoded file to storage servers via SFTP/rsync/SMB.

**Config:**
```typescript
interface DeliverStepConfig {
  verifyDelivery?: boolean;     // Verify file integrity (default: true)
}
```

**Outputs:**
```typescript
{
  deliver: {
    delivered: boolean;
    servers: string[];
    paths: string[];
  }
}
```

### APPROVAL

Pause pipeline and wait for manual approval.

**Config:**
```typescript
interface ApprovalStepConfig {
  reason?: string;              // Approval reason message
  requiredRole?: "admin" | "moderator" | "any";
  timeoutHours?: number;        // Auto-reject timeout (default: 24)
  autoAction?: "approve" | "reject" | "cancel";
  includeContext?: boolean;     // Include full context in approval
}
```

**Outputs:**
```typescript
{
  approval: {
    approvalId: string;
    status: "PENDING" | "APPROVED" | "REJECTED" | "TIMEOUT";
    processedBy?: string;
    comment?: string;
  }
}
```

**Behavior:**
- Returns `shouldPause: true` to halt execution
- Pipeline resumes when approval is processed
- Use `resumeExecution` endpoint to continue

### NOTIFICATION

Send notifications to configured providers (Discord, email, etc.).

**Config:**
```typescript
interface NotificationStepConfig {
  event: string;                // Event name (e.g., "REQUEST_COMPLETED")
  includeContext?: boolean;     // Include full context in notification
  continueOnError?: boolean;    // Don't fail pipeline if notification fails
}
```

**Outputs:**
```typescript
{
  notification: {
    sent: boolean;
    providers: string[];
    errors?: Array<{ provider: string; error: string }>;
  }
}
```

## Parallel Execution

The pipeline executor supports true parallel execution using tree structures.

### Sequential vs Parallel

**Sequential (linear chain):**
```
SEARCH → DOWNLOAD → ENCODE → DELIVER
```

In the step tree, each step has at most one child:
```json
{
  "type": "SEARCH",
  "children": [{
    "type": "DOWNLOAD",
    "children": [{ "type": "ENCODE" }]
  }]
}
```

**Parallel (branching):**
```
SEARCH → DOWNLOAD → ┬─ ENCODE → DELIVER
                    └─ NOTIFICATION
```

In the step tree, a step can have multiple children:
```json
{
  "type": "DOWNLOAD",
  "children": [
    { "type": "ENCODE" },
    { "type": "NOTIFICATION" }
  ]
}
```

### Execution Model

When a step has multiple children, they all execute in parallel using `Promise.all()`:

```typescript
// Execute all children concurrently
const results = await Promise.all(
  children.map(child => executeStep(child))
);

// Merge all branch contexts
const mergedContext = results.reduce(
  (acc, ctx) => ({ ...acc, ...ctx }),
  currentContext
);
```

### Branch Independence

Parallel branches are completely independent:
- Each branch gets a copy of the current context
- Branches cannot affect each other during execution
- Context merging happens after all branches complete
- If one branch fails and `continueOnError: false`, the pipeline fails

### Example: Multi-Server Delivery

```
SEARCH → DOWNLOAD → ENCODE → ┬─ DELIVER (Server 1)
                              ├─ DELIVER (Server 2)
                              └─ DELIVER (Server 3)
```

All three deliveries happen simultaneously.

## Creating Pipelines

### Using the UI

1. Navigate to **Settings → Pipelines**
2. Click **New Pipeline**
3. Configure template:
   - Name: "My Custom Pipeline"
   - Media Type: Movie or TV
   - Description (optional)
4. Drag steps from the palette onto the canvas
5. Connect steps by dragging from output handles to input handles
6. Double-click steps to configure settings
7. Click **Save** to create the template

### Using the API

```typescript
import { trpc } from "./trpc";

const template = await trpc.pipelines.create.mutate({
  name: "AV1 Encode Pipeline",
  description: "Search, download, encode to AV1, deliver",
  mediaType: "MOVIE",
  isDefault: false,
  isPublic: true,
  steps: [
    {
      type: "SEARCH",
      name: "Find high-quality release",
      config: { minSeeds: 10, timeoutSeconds: 600 },
      required: true,
      retryable: true,
      continueOnError: false,
      children: [
        {
          type: "DOWNLOAD",
          name: "Download source",
          config: { maxDownloadHours: 48 },
          children: [
            {
              type: "ENCODE",
              name: "Encode to AV1",
              config: { crf: 24, maxResolution: "2160p", preset: "medium" },
              children: [
                {
                  type: "DELIVER",
                  name: "Deliver to servers",
                  config: { verifyDelivery: true },
                }
              ]
            }
          ]
        }
      ]
    }
  ]
});
```

## Managing Executions

### Starting Execution

When creating a media request, specify the template:

```typescript
const request = await trpc.requests.createMovie.mutate({
  tmdbId: 550,
  title: "Fight Club",
  year: 1999,
  targets: [{ serverId: "server-1" }],
  pipelineTemplateId: template.id,  // Use custom pipeline
});
```

If no `pipelineTemplateId` is provided, falls back to legacy pipeline.

### Monitoring Execution

Get execution status:

```typescript
const execution = await trpc.pipelines.getExecutionByRequest.query({
  requestId: request.id
});

console.log(execution.status);      // RUNNING, PAUSED, COMPLETED, FAILED, CANCELLED
console.log(execution.currentStep); // Current step index
console.log(execution.context);     // Accumulated context
```

List step-by-step history:

```typescript
execution.stepExecutions.forEach(step => {
  console.log(`${step.stepType}: ${step.status} (${step.progress}%)`);
});
```

### Controlling Execution

**Cancel:**
```typescript
await trpc.pipelines.cancelExecution.mutate({ id: execution.id });
```

**Resume (for paused/approval steps):**
```typescript
await trpc.pipelines.resumeExecution.mutate({ id: execution.id });
```

## Migration from Legacy

### Gradual Migration Strategy

The new pipeline system runs alongside the legacy system:

1. **Create templates** for your most common workflows
2. **Test** new pipelines on a few requests
3. **Set as default** once validated
4. **Eventually remove** legacy code (Phase 8)

### Legacy Fallback

If no `pipelineTemplateId` is specified, requests use legacy pipelines:

```typescript
// Uses new pipeline system
await trpc.requests.createMovie.mutate({
  ...movieData,
  pipelineTemplateId: "custom-template-id"
});

// Uses legacy pipeline (backwards compatible)
await trpc.requests.createMovie.mutate({
  ...movieData
  // No pipelineTemplateId
});
```

### Feature Comparison

| Feature | Legacy | New System |
|---------|--------|------------|
| Visual editor | ❌ | ✅ |
| Parallel execution | ❌ | ✅ |
| Custom steps | ❌ | ✅ |
| Approval workflows | ❌ | ✅ |
| Per-step retry | ❌ | ✅ |
| Resume support | ❌ | ✅ |
| Step-by-step history | ❌ | ✅ |

## Development Guide

### Adding a Custom Step Type

1. **Define the step interface:**

```typescript
// packages/server/src/services/pipeline/steps/MyCustomStep.ts
import { BaseStep, type StepOutput } from "./BaseStep.js";
import type { PipelineContext } from "../PipelineContext.js";
import { StepType } from "@prisma/client";

interface MyCustomStepConfig {
  setting1?: string;
  setting2?: number;
}

export class MyCustomStep extends BaseStep {
  readonly type = StepType.MY_CUSTOM;

  validateConfig(config: unknown): void {
    // Validate config structure
  }

  async execute(context: PipelineContext, config: unknown): Promise<StepOutput> {
    const cfg = (config as MyCustomStepConfig) || {};

    // Do work
    const result = await doSomething(context, cfg);

    // Return output
    return {
      success: true,
      data: {
        myCustomField: result
      }
    };
  }
}
```

2. **Add to Prisma schema:**

```prisma
enum StepType {
  SEARCH
  DOWNLOAD
  ENCODE
  DELIVER
  APPROVAL
  NOTIFICATION
  MY_CUSTOM       // Add here
}
```

3. **Register the step:**

```typescript
// packages/server/src/services/pipeline/registerSteps.ts
import { MyCustomStep } from './steps/MyCustomStep.js';

StepRegistry.register(StepType.MY_CUSTOM, MyCustomStep);
```

4. **Add UI config (optional):**

```typescript
// packages/client/src/components/pipeline/StepConfigModal.tsx
case "MY_CUSTOM":
  return (
    <div className="space-y-3">
      <div>
        <Label>Setting 1</Label>
        <Input
          value={(config.setting1 as string) || ""}
          onChange={(e) => setConfig({ ...config, setting1: e.target.value })}
        />
      </div>
    </div>
  );
```

5. **Run migration and rebuild:**

```bash
bunx prisma migrate dev --name add-my-custom-step
bun run build
```

### Testing Pipelines

Use the test endpoint to validate templates:

```typescript
const result = await trpc.pipelines.test.mutate({
  id: template.id,
  mockData: {
    tmdbId: 550,
    title: "Fight Club",
    year: 1999
  }
});
```

### Debugging

Pipeline execution logs to console and activity log:

```typescript
// Server logs
[Pipeline] Started pipeline execution <execution-id> for request <request-id>
[Pipeline] Executing step SEARCH: Find torrent
[Pipeline] Step SEARCH completed in 5.2s
[Pipeline] Executing parallel branches: 2 children
[Pipeline] All branches completed, merging context

// Activity log (stored in database)
await prisma.activityLog.findMany({
  where: { requestId: request.id },
  orderBy: { timestamp: "asc" }
});
```

Use the React Flow dev tools to debug visual editor issues.

## Best Practices

1. **Start simple**: Create basic linear pipelines before branching
2. **Use meaningful names**: Name steps clearly (e.g., "Encode to AV1 4K HDR")
3. **Configure timeouts**: Set realistic timeouts for long-running steps
4. **Enable retries**: Mark transient failure steps as `retryable`
5. **Test first**: Use the test endpoint before deploying to production
6. **Monitor executions**: Check step execution history for failures
7. **Version templates**: Create new templates instead of modifying production ones

## Troubleshooting

**Pipeline stuck in RUNNING:**
- Check step execution history for which step is stuck
- Look for timeout issues or external service failures
- Cancel and retry with higher timeouts

**Parallel branches not executing:**
- Verify step tree structure has multiple children
- Check that all children have valid configurations
- Look for validation errors in server logs

**Context data missing:**
- Ensure previous steps completed successfully
- Check step output structure matches expected format
- Verify context merging is working (check execution context)

**UI not loading:**
- Clear browser cache and reload
- Check React Flow version compatibility
- Verify layout JSON is valid

## API Reference

See `packages/server/src/routers/pipelines.ts` for full API documentation.

### Endpoints

- `list` - List all templates
- `get` - Get template by ID
- `create` - Create new template
- `update` - Update template
- `delete` - Delete template
- `execute` - Start execution for request
- `getExecution` - Get execution by ID
- `getExecutionByRequest` - Get execution for request
- `listExecutions` - List executions with filters
- `cancelExecution` - Cancel running execution
- `resumeExecution` - Resume paused execution
- `test` - Test template with mock data
