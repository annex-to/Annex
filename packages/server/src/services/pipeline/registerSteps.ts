// Register all pipeline step implementations with the StepRegistry
// This should be called once during application startup

import { StepType } from '@prisma/client';
import { StepRegistry } from './StepRegistry.js';
import { SearchStep } from './steps/SearchStep.js';
import { DownloadStep } from './steps/DownloadStep.js';
import { DeliverStep } from './steps/DeliverStep.js';

export function registerPipelineSteps(): void {
  // Register core pipeline steps
  StepRegistry.register(StepType.SEARCH, SearchStep);
  StepRegistry.register(StepType.DOWNLOAD, DownloadStep);
  StepRegistry.register(StepType.DELIVER, DeliverStep);

  console.log('[Pipeline] Registered pipeline steps:', StepRegistry.getRegisteredTypes());
}
