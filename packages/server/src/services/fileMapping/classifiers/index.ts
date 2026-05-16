import type { DownloadFileKind } from "@prisma/client";

const VIDEO_EXTENSIONS = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"];
const SUBTITLE_EXTENSIONS = [".srt", ".ass", ".ssa", ".vtt", ".sub", ".idx"];
const EXTRA_EXTENSIONS = [".nfo", ".jpg", ".png", ".txt", ".sfv", ".md5"];
const SAMPLE_RE = /(?:^|[._\- ])sample(?:[._\- ]|$)/i;
const MIN_VIDEO_BYTES = 100 * 1024 * 1024;

export interface Classification {
  kind: DownloadFileKind;
  rejected: boolean;
  rejectReason?: string;
}

export function classifyFile(input: { name: string; sizeBytes: number }): Classification {
  const lower = input.name.toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
  const isSubtitle = SUBTITLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  const isExtra = EXTRA_EXTENSIONS.some((ext) => lower.endsWith(ext));

  if (isVideo) {
    if (SAMPLE_RE.test(input.name)) {
      return { kind: "VIDEO_SAMPLE", rejected: true, rejectReason: "sample" };
    }
    if (input.sizeBytes < MIN_VIDEO_BYTES) {
      return { kind: "VIDEO_SAMPLE", rejected: true, rejectReason: "too_small" };
    }
    return { kind: "VIDEO_MAIN", rejected: false };
  }
  if (isSubtitle) return { kind: "SUBTITLE", rejected: false };
  if (isExtra) return { kind: "EXTRA", rejected: false };
  return { kind: "UNKNOWN", rejected: false };
}
