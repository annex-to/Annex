import { trpc } from "../../trpc";
import { Badge, Button } from "./index";
import { Modal } from "./Modal";

interface ManualSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  requestId: string | null;
}

interface Release {
  id: string;
  title: string;
  indexerId: string;
  indexerName: string;
  resolution: string;
  source: string;
  codec: string;
  size: number;
  seeders: number;
  leechers: number;
  magnetUri?: string;
  downloadUrl?: string;
  infoUrl?: string;
  publishDate: Date;
  score: number;
  categories: number[];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

function ManualSearchModal({ isOpen, onClose, requestId }: ManualSearchModalProps) {
  const utils = trpc.useUtils();

  const searchResults = trpc.requests.manualSearch.useQuery(
    { requestId: requestId || "" },
    { enabled: isOpen && !!requestId }
  );

  const selectMutation = trpc.requests.selectManualRelease.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      onClose();
    },
  });

  const handleSelect = (release: Release) => {
    if (!requestId) return;
    selectMutation.mutate({ requestId, release });
  };

  if (!isOpen || !requestId) return null;

  const data = searchResults.data;

  return (
    <Modal isOpen={isOpen} onClose={onClose} className="w-full max-w-3xl mx-4">
      <div className="bg-surface-800 rounded-lg overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-surface-700">
          <h2 className="text-lg font-semibold">Manual Search</h2>
          {data && (
            <p className="text-sm text-surface-400 mt-1">
              {data.requestInfo.title} ({data.requestInfo.year})
            </p>
          )}
        </div>

        {/* Content */}
        <div className="p-4 max-h-[70vh] overflow-y-auto">
          {searchResults.isLoading && (
            <div className="py-12 text-center text-surface-400">Searching indexers...</div>
          )}

          {searchResults.isError && (
            <div className="py-12 text-center text-red-400">Failed to search for releases</div>
          )}

          {data && (
            <div className="space-y-3">
              {data.releases.length > 0 ? (
                data.releases.map((release: Release, index: number) => (
                  <div
                    key={`${release.indexerId}-${release.id || index}`}
                    className="bg-surface-700/50 border border-surface-600 rounded p-3 hover:bg-surface-700 transition-all"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        {/* Title */}
                        <div className="text-sm font-medium truncate" title={release.title}>
                          {release.title}
                        </div>

                        {/* Badges */}
                        <div className="flex flex-wrap gap-2 mt-2">
                          {release.resolution && <Badge variant="info">{release.resolution}</Badge>}
                          {release.source && <Badge variant="default">{release.source}</Badge>}
                          {release.codec && <Badge variant="default">{release.codec}</Badge>}
                          {release.score && <Badge variant="success">Score: {release.score}</Badge>}
                        </div>

                        {/* Metadata */}
                        <div className="flex items-center gap-4 mt-2 text-xs text-surface-400">
                          {release.size && <span>{formatBytes(release.size)}</span>}
                          {release.seeders !== undefined && (
                            <span className="text-green-400">{release.seeders} seeders</span>
                          )}
                          {release.leechers !== undefined && (
                            <span className="text-orange-400">{release.leechers} leechers</span>
                          )}
                          {release.indexerName && <span>{release.indexerName}</span>}
                        </div>
                      </div>

                      {/* Select button */}
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleSelect(release)}
                        disabled={selectMutation.isPending}
                      >
                        {selectMutation.isPending ? "Selecting..." : "Select"}
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-12 text-center text-surface-400">No releases found</div>
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

export { ManualSearchModal };
export type { ManualSearchModalProps };
