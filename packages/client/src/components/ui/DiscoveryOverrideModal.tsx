import { trpc } from "../../trpc";
import { Button } from "./Button";

interface DiscoveryOverrideModalProps {
  isOpen: boolean;
  onClose: () => void;
  itemId: string | null;
}

export function DiscoveryOverrideModal({ isOpen, onClose, itemId }: DiscoveryOverrideModalProps) {
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.requests.getDiscoveredDetails.useQuery(
    { itemId: itemId || "" },
    { enabled: isOpen && !!itemId }
  );

  const overrideMutation = trpc.requests.overrideDiscoveredRelease.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      onClose();
    },
  });

  const approveMutation = trpc.requests.approveDiscoveredItem.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      onClose();
    },
  });

  const handleOverride = (releaseIndex: number) => {
    if (!itemId) return;
    overrideMutation.mutate({ itemId, releaseIndex });
  };

  const handleApprove = () => {
    if (!itemId) return;
    approveMutation.mutate({ itemId });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-sm">
      <div className="bg-black/80 backdrop-blur-md rounded border border-white/20 w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-2xl">
        <div className="p-4 border-b border-white/20 bg-white/5">
          <h2 className="text-lg font-semibold text-white">Discovery Override</h2>
          {data && (
            <p className="text-sm text-white/80 mt-1">
              {data.item.title} - {data.remainingSeconds}s remaining
            </p>
          )}
        </div>

        <div className="p-4 max-h-[70vh] overflow-y-auto">
          {isLoading && <div className="py-12 text-center text-white/60">Loading...</div>}

          {data && (
            <>
              {data.selectedRelease && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-white/90 mb-2">
                    Currently Selected (auto-download in {data.remainingSeconds}s)
                  </h3>
                  <ReleaseCard release={data.selectedRelease} isSelected />
                </div>
              )}

              <div>
                <h3 className="text-sm font-medium text-white/90 mb-2">All Search Results</h3>
                <div className="space-y-3">
                  {data.allSearchResults.map((release, index) => (
                    <div key={`${release.title}-${index}`}>
                      <ReleaseCard release={release} />
                      {release !== data.selectedRelease && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="mt-2"
                          onClick={() => handleOverride(index)}
                          disabled={overrideMutation.isPending}
                        >
                          Select This Release (30s cooldown)
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="p-4 border-t border-white/10 flex justify-between">
          <Button
            variant="primary"
            onClick={handleApprove}
            disabled={approveMutation.isPending || !data}
          >
            {approveMutation.isPending ? "Approving..." : "Approve Now (Skip Cooldown)"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

interface Release {
  title: string;
  indexerName?: string;
  resolution?: string;
  source?: string;
  codec?: string;
  score?: number;
  size?: number;
  seeders?: number;
}

function ReleaseCard({ release, isSelected }: { release: Release; isSelected?: boolean }) {
  return (
    <div
      className={`bg-white/10 backdrop-blur-sm border rounded p-3 ${
        isSelected ? "border-annex-500/60 bg-annex-500/10" : "border-white/20"
      }`}
    >
      <div className="text-sm font-medium truncate text-white" title={release.title}>
        {release.title}
      </div>
      <div className="flex flex-wrap gap-2 mt-2">
        {release.indexerName && (
          <span className="px-2 py-1 bg-annex-500/20 rounded border border-annex-500/30 text-xs text-annex-300">
            {release.indexerName}
          </span>
        )}
        {release.resolution && (
          <span className="px-2 py-1 bg-blue-500/20 rounded border border-blue-500/30 text-xs text-blue-300">
            {release.resolution}
          </span>
        )}
        {release.source && (
          <span className="px-2 py-1 bg-purple-500/20 rounded border border-purple-500/30 text-xs text-purple-300">
            {release.source}
          </span>
        )}
        {release.codec && (
          <span className="px-2 py-1 bg-cyan-500/20 rounded border border-cyan-500/30 text-xs text-cyan-300">
            {release.codec}
          </span>
        )}
        {release.score && (
          <span className="px-2 py-1 bg-gold-500/20 rounded border border-gold-500/30 text-xs text-gold-300">
            Score: {release.score}
          </span>
        )}
      </div>
      <div className="flex items-center gap-4 mt-2 text-xs text-white/60">
        {release.size && <span>{formatBytes(release.size)}</span>}
        {release.seeders !== undefined && (
          <span className="text-green-300">{release.seeders} seeders</span>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}
