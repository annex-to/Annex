/**
 * Archive Extraction Service
 *
 * Handles extraction of RAR archives commonly found in scene releases.
 * Supports multi-part RAR archives (.rar, .r00, .r01, etc.)
 */

import { spawn } from "child_process";
import { existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, basename, dirname } from "path";

export interface ExtractionResult {
  success: boolean;
  extractedFiles: string[];
  error?: string;
}

export interface ArchiveInfo {
  hasArchive: boolean;
  archivePath: string | null;
  estimatedSize: number;
}

/**
 * Check if a directory contains RAR archives
 */
export function detectRarArchive(directory: string): ArchiveInfo {
  if (!existsSync(directory)) {
    return { hasArchive: false, archivePath: null, estimatedSize: 0 };
  }

  const files = readdirSync(directory);

  // Look for .rar file (the first part of the archive)
  const rarFile = files.find((f) => f.toLowerCase().endsWith(".rar"));

  if (!rarFile) {
    return { hasArchive: false, archivePath: null, estimatedSize: 0 };
  }

  // Calculate total archive size (including .r00, .r01, etc.)
  let totalSize = 0;
  const baseName = rarFile.replace(/\.rar$/i, "");

  for (const file of files) {
    const lower = file.toLowerCase();
    // Match .rar and .r00-.r99 parts
    if (lower === rarFile.toLowerCase() || lower.match(new RegExp(`^${escapeRegex(baseName.toLowerCase())}\\.r\\d{2}$`))) {
      const filePath = join(directory, file);
      try {
        totalSize += statSync(filePath).size;
      } catch {
        // Ignore stat errors
      }
    }
  }

  return {
    hasArchive: true,
    archivePath: join(directory, rarFile),
    estimatedSize: totalSize,
  };
}

/**
 * Extract a RAR archive to a destination directory
 */
export async function extractRar(
  archivePath: string,
  destinationDir?: string,
  options?: {
    onProgress?: (message: string) => void;
  }
): Promise<ExtractionResult> {
  if (!existsSync(archivePath)) {
    return {
      success: false,
      extractedFiles: [],
      error: `Archive not found: ${archivePath}`,
    };
  }

  // Default to extracting in the same directory as the archive
  const extractDir = destinationDir || dirname(archivePath);

  // Ensure destination exists
  if (!existsSync(extractDir)) {
    mkdirSync(extractDir, { recursive: true });
  }

  return new Promise((resolve) => {
    const extractedFiles: string[] = [];

    // Use unrar to extract
    // -o+ : overwrite existing files
    // -y  : assume yes to all queries
    const unrar = spawn("unrar", ["x", "-o+", "-y", archivePath, extractDir]);

    let stderr = "";

    unrar.stdout.on("data", (data) => {
      const output = data.toString();

      // Parse extracted filenames from unrar output
      // unrar outputs lines like "Extracting  filename.mkv                                           OK"
      const lines = output.split("\n");
      for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip empty lines and progress-only lines (just percentages)
        if (!trimmedLine || /^\d+%$/.test(trimmedLine)) {
          continue;
        }

        // Only log meaningful messages (not progress percentages)
        if (trimmedLine.startsWith("Extracting") ||
            trimmedLine.startsWith("...") ||
            trimmedLine === "All OK" ||
            trimmedLine.includes("Copyright")) {
          options?.onProgress?.(trimmedLine);
        }

        const match = line.match(/^(?:Extracting|\.\.\.)\s+(.+?)\s+(?:OK|100%|\d+%)/);
        if (match) {
          const filename = match[1].trim();
          if (filename && !extractedFiles.includes(filename)) {
            extractedFiles.push(join(extractDir, basename(filename)));
          }
        }
      }
    });

    unrar.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    unrar.on("close", (code) => {
      if (code === 0) {
        // If we didn't capture files from output, scan the directory for video files
        if (extractedFiles.length === 0) {
          const videoExtensions = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"];
          try {
            const allFiles = readdirSync(extractDir);
            for (const file of allFiles) {
              const lower = file.toLowerCase();
              if (videoExtensions.some((ext) => lower.endsWith(ext))) {
                // Check if this file is newer than the archive (likely just extracted)
                const filePath = join(extractDir, file);
                extractedFiles.push(filePath);
              }
            }
          } catch {
            // Ignore scan errors
          }
        }

        resolve({
          success: true,
          extractedFiles,
        });
      } else {
        resolve({
          success: false,
          extractedFiles,
          error: stderr || `unrar exited with code ${code}`,
        });
      }
    });

    unrar.on("error", (err) => {
      resolve({
        success: false,
        extractedFiles: [],
        error: `Failed to spawn unrar: ${err.message}`,
      });
    });
  });
}

/**
 * Check if a file path indicates a sample file
 * Sample files are typically in a "Sample" folder or have "sample" in the filename
 */
export function isSampleFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();

  // Check for "sample" folder in path (with or without leading slash)
  if (
    lower.includes("/sample/") ||
    lower.includes("\\sample\\") ||
    lower.startsWith("sample/") ||
    lower.startsWith("sample\\")
  ) {
    return true;
  }

  // Check for "sample" in filename (but not as part of another word)
  const filename = basename(lower);
  if (filename.includes("-sample.") || filename.includes(".sample.") || filename.includes("_sample.")) {
    return true;
  }
  if (filename.startsWith("sample.") || filename.startsWith("sample-") || filename.startsWith("sample_")) {
    return true;
  }

  return false;
}

/**
 * Filter video files to exclude samples and prioritize real content
 */
export function filterVideoFiles(
  files: Array<{ name: string; size: number }>,
  minSizeBytes: number = 100 * 1024 * 1024 // 100MB minimum for real content
): Array<{ name: string; size: number }> {
  return files.filter((f) => {
    // Exclude sample files
    if (isSampleFile(f.name)) {
      return false;
    }

    // Exclude very small files (likely samples even without the name)
    if (f.size < minSizeBytes) {
      return false;
    }

    return true;
  });
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
