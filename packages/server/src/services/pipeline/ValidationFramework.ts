import type { ProcessingItem, ProcessingStatus } from "@prisma/client";

export class ValidationError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly status: ProcessingStatus,
    public readonly validationType: "entry" | "exit",
    message: string
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validation framework for ProcessingItem state transitions
 */
export class ValidationFramework {
  /**
   * Validate entry conditions for a status
   */
  async validateEntry(
    item: ProcessingItem,
    targetStatus: ProcessingStatus
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    switch (targetStatus) {
      case "PENDING":
        // Always valid - initial state
        break;

      case "SEARCHING":
        if (!item.tmdbId) {
          errors.push("TMDB ID required for searching");
        }
        if (!item.title) {
          errors.push("Title required for searching");
        }
        break;

      case "FOUND": {
        // Requires either a selected release or existing download in stepContext
        const searchContext = item.stepContext as Record<string, unknown>;
        const hasSelectedRelease = !!searchContext?.selectedRelease;
        const hasExistingDownload = !!searchContext?.existingDownload;

        if (!hasSelectedRelease && !hasExistingDownload) {
          errors.push("No release selected from search results");
        }
        break;
      }

      case "DOWNLOADING":
        // Download ID is optional for existing downloads in qBittorrent
        break;

      case "DOWNLOADED": {
        // Download ID is optional for existing downloads
        // File validation should be done before transition
        const downloadContext = item.stepContext as Record<string, unknown>;
        const downloadData = downloadContext?.download as Record<string, unknown>;

        if (!downloadData?.sourceFilePath && !downloadData?.episodeFiles) {
          errors.push("Download file path required for downloaded state");
        }
        break;
      }

      case "ENCODING": {
        // Encoding job ID is optional - it gets set during the encoding process
        // Require download data to be present (contains source file)
        const encodeEntryContext = item.stepContext as Record<string, unknown>;
        const downloadData = encodeEntryContext?.download as Record<string, unknown>;

        if (!downloadData?.sourceFilePath && !downloadData?.episodeFiles) {
          errors.push("Download data required for encoding");
        }
        break;
      }

      case "ENCODED": {
        // encodingJobId is optional - not all encoding workflows set it
        // Encoded file validation should be done before transition
        const encodeExitContext = item.stepContext as Record<string, unknown>;
        const encodeData = encodeExitContext?.encode as Record<string, unknown>;
        const encodedFiles = encodeData?.encodedFiles as Array<Record<string, unknown>>;

        if (!encodedFiles || encodedFiles.length === 0 || !encodedFiles[0]?.path) {
          errors.push("Encoded file path required for encoded state");
        }
        break;
      }

      case "DELIVERING": {
        // Check for encoded files from the encode step
        const deliveryContext = item.stepContext as Record<string, unknown>;
        const encodeData = deliveryContext?.encode as Record<string, unknown>;
        const encodedFiles = encodeData?.encodedFiles as Array<Record<string, unknown>>;

        if (!encodedFiles || encodedFiles.length === 0 || !encodedFiles[0]?.path) {
          errors.push("Encoded file path required for delivery");
        }
        // Note: Target servers are stored in the MediaRequest, not in stepContext
        // So we don't validate them here - DeliverWorker will handle that
        break;
      }

      case "COMPLETED": {
        // All delivery confirmations should be in stepContext
        const completionContext = item.stepContext as Record<string, unknown>;
        if (!completionContext?.deliveryResults) {
          errors.push("Delivery results required for completion");
        }
        break;
      }

      case "FAILED":
        // Always valid - can fail from any state
        break;

      case "CANCELLED":
        // Always valid - can cancel from any state
        break;

      default:
        errors.push(`Unknown status: ${targetStatus}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate exit conditions for a status
   */
  async validateExit(
    item: ProcessingItem,
    currentStatus: ProcessingStatus
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    switch (currentStatus) {
      case "PENDING":
        // No exit validation needed
        break;

      case "SEARCHING": {
        // Must have found either a new release or existing download
        const searchContext = item.stepContext as Record<string, unknown>;
        const hasSelectedRelease = !!searchContext?.selectedRelease;
        const hasExistingDownload = !!searchContext?.existingDownload;

        if (!hasSelectedRelease && !hasExistingDownload) {
          errors.push("No search results found");
        }
        break;
      }

      case "FOUND": {
        // Must have either selected a release or found existing download
        const foundContext = item.stepContext as Record<string, unknown>;
        const hasSelectedRelease = !!foundContext?.selectedRelease;
        const hasExistingDownload = !!foundContext?.existingDownload;

        if (!hasSelectedRelease && !hasExistingDownload) {
          errors.push("No release selected");
        }
        break;
      }

      case "DOWNLOADING": {
        // Download must be complete
        const stepContext = item.stepContext as Record<string, unknown>;
        const downloadData = stepContext?.download as Record<string, unknown>;

        if (
          !downloadData?.isComplete &&
          !downloadData?.sourceFilePath &&
          !downloadData?.episodeFiles
        ) {
          errors.push("Download not marked as complete");
        }
        break;
      }

      case "DOWNLOADED": {
        // File must exist (validation done in entry check)
        const downloadedContext = item.stepContext as Record<string, unknown>;
        const downloadData = downloadedContext?.download as Record<string, unknown>;

        if (!downloadData?.sourceFilePath && !downloadData?.episodeFiles) {
          errors.push("Download file path not set");
        }
        break;
      }

      case "ENCODING": {
        // Encoding must be complete - check for encoded files
        const encodingContext = item.stepContext as Record<string, unknown>;
        const encodeData = encodingContext?.encode as Record<string, unknown>;
        const encodedFiles = encodeData?.encodedFiles as Array<Record<string, unknown>>;

        if (!encodedFiles || encodedFiles.length === 0 || !encodedFiles[0]?.path) {
          errors.push("Encoding not complete - no encoded files found");
        }
        break;
      }

      case "ENCODED": {
        // Encoded file must be present
        const encodedContext = item.stepContext as Record<string, unknown>;
        const encodeData = encodedContext?.encode as Record<string, unknown>;
        const encodedFiles = encodeData?.encodedFiles as Array<Record<string, unknown>>;

        if (!encodedFiles || encodedFiles.length === 0 || !encodedFiles[0]?.path) {
          errors.push("Encoded file path not set");
        }
        break;
      }

      case "DELIVERING": {
        // All deliveries must be complete
        const deliveringContext = item.stepContext as Record<string, unknown>;
        if (!deliveringContext?.allDeliveriesComplete) {
          errors.push("Not all deliveries marked as complete");
        }
        break;
      }

      case "COMPLETED":
      case "FAILED":
      case "CANCELLED":
        // Terminal states - no exit validation
        break;

      default:
        errors.push(`Unknown status: ${currentStatus}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate both entry and exit conditions for a transition
   */
  async validateTransition(
    item: ProcessingItem,
    fromStatus: ProcessingStatus,
    toStatus: ProcessingStatus,
    newContext?: {
      stepContext?: Record<string, unknown>;
      downloadId?: string;
      encodingJobId?: string;
    }
  ): Promise<ValidationResult> {
    // Create a temporary item with new fields for validation
    const itemForValidation = {
      ...item,
      ...(newContext?.stepContext && {
        stepContext: newContext.stepContext as import("@prisma/client").Prisma.JsonValue,
      }),
      ...(newContext?.downloadId && { downloadId: newContext.downloadId }),
      ...(newContext?.encodingJobId && { encodingJobId: newContext.encodingJobId }),
    };

    // First validate exit from current status (using new context)
    const exitValidation = await this.validateExit(itemForValidation, fromStatus);
    if (!exitValidation.valid) {
      return {
        valid: false,
        errors: exitValidation.errors.map((e) => `Exit validation failed: ${e}`),
      };
    }

    // Then validate entry to new status (using new context)
    const entryValidation = await this.validateEntry(itemForValidation, toStatus);
    if (!entryValidation.valid) {
      return {
        valid: false,
        errors: entryValidation.errors.map((e) => `Entry validation failed: ${e}`),
      };
    }

    return { valid: true, errors: [] };
  }

  /**
   * Throw ValidationError if validation fails
   */
  async assertValid(
    item: ProcessingItem,
    status: ProcessingStatus,
    validationType: "entry" | "exit"
  ): Promise<void> {
    const validation =
      validationType === "entry"
        ? await this.validateEntry(item, status)
        : await this.validateExit(item, status);

    if (!validation.valid) {
      throw new ValidationError(
        item.id,
        status,
        validationType,
        `Validation failed: ${validation.errors.join(", ")}`
      );
    }
  }
}

export const validationFramework = new ValidationFramework();
