import { Modal } from "./Modal";
import { Button, Badge } from "./index";
import { trpc } from "../../trpc";

interface AlternativesModalProps {
  isOpen: boolean;
  onClose: () => void;
  requestId: string | null;
}

interface AvailableRelease {
  title: string;
  resolution?: string;
  source?: string;
  codec?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  score?: number;
  downloadUrl?: string;
  magnetUri?: string;
  indexerName?: string;
  indexerId?: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function AlternativesModal({ isOpen, onClose, requestId }: AlternativesModalProps) {
  const utils = trpc.useUtils();

  const alternatives = trpc.requests.getAlternatives.useQuery(
    { id: requestId! },
    { enabled: isOpen && !!requestId }
  );

  const acceptMutation = trpc.requests.acceptLowerQuality.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      onClose();
    },
  });

  if (!isOpen || !requestId) return null;

  const data = alternatives.data;

  return (
    <Modal isOpen={isOpen} onClose={onClose} className="w-full max-w-2xl mx-4">
      <div className="bg-surface-800 rounded-lg overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-surface-700">
          <h2 className="text-lg font-semibold">Alternative Releases</h2>
          {data && (
            <p className="text-sm text-surface-400 mt-1">
              {data.title} ({data.year})
            </p>
          )}
        </div>

        {/* Content */}
        <div className="p-4 max-h-[60vh] overflow-y-auto">
          {alternatives.isLoading && (
            <div className="py-8 text-center text-surface-400">
              Loading alternatives...
            </div>
          )}

          {alternatives.isError && (
            <div className="py-8 text-center text-red-400">
              Failed to load alternatives
            </div>
          )}

          {data && (
            <div className="space-y-4">
              {/* Quality info */}
              <div className="bg-orange-500/10 border border-orange-500/30 rounded p-3">
                <div className="text-sm text-orange-300">
                  <span className="font-medium">Required quality:</span>{" "}
                  {data.requiredResolution || "Unknown"}
                </div>
                <div className="text-xs text-orange-400 mt-1">
                  These releases are below the required quality. Select one to proceed anyway.
                </div>
              </div>

              {/* Release list */}
              {data.availableReleases && data.availableReleases.length > 0 ? (
                <div className="space-y-2">
                  {(data.availableReleases as AvailableRelease[]).map((release, index) => (
                    <div
                      key={index}
                      className="bg-surface-700/50 border border-surface-600 rounded p-3"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate" title={release.title || ""}>
                            {release.title || "Unknown"}
                          </div>
                          <div className="flex flex-wrap gap-2 mt-2">
                            <Badge variant="info">
                              {release.resolution || "Unknown"}
                            </Badge>
                            {release.source && (
                              <Badge variant="default">
                                {release.source}
                              </Badge>
                            )}
                            {release.codec && (
                              <Badge variant="default">
                                {release.codec}
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-4 mt-2 text-xs text-surface-400">
                            {release.size !== undefined && (
                              <span>{formatBytes(release.size)}</span>
                            )}
                            {release.seeders !== undefined && (
                              <span className="text-green-400">
                                {release.seeders} seeders
                              </span>
                            )}
                            {release.indexerName && (
                              <span>{release.indexerName}</span>
                            )}
                          </div>
                        </div>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() =>
                            acceptMutation.mutate({
                              id: requestId,
                              releaseIndex: index,
                            })
                          }
                          disabled={acceptMutation.isPending}
                        >
                          {acceptMutation.isPending ? "Accepting..." : "Accept"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center text-surface-400">
                  No alternative releases available
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-surface-700 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export { AlternativesModal };
export type { AlternativesModalProps };
