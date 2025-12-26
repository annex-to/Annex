import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { trpc } from "../../trpc";
import { Button } from "./Button";
import { Modal } from "./Modal";

interface RequestDialogProps {
  isOpen: boolean;
  onClose: () => void;
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  year: number;
  posterPath?: string | null;
  seasons?: number[];
  episodes?: Array<{ season: number; episode: number }>;
}

interface ServerSelection {
  serverId: string;
}

interface Server {
  id: string;
  name: string;
  maxResolution: string;
  encodingProfileId?: string;
}

interface Pipeline {
  id: string;
  name: string;
  description: string | null;
  stepCount: number;
  isDefault: boolean;
}

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

function RequestDialog({
  isOpen,
  onClose,
  tmdbId,
  type,
  title,
  year,
  posterPath,
  seasons,
  episodes,
}: RequestDialogProps) {
  const [serverSelections, setServerSelections] = useState<Map<string, ServerSelection>>(new Map());
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Fetch available targets (servers and encoding profiles)
  const { data: targets, isLoading: targetsLoading } = trpc.requests.getAvailableTargets.useQuery(
    undefined,
    { enabled: isOpen }
  );

  // Fetch available pipeline templates for this media type
  const { data: pipelines, isLoading: pipelinesLoading } = trpc.pipelines.list.useQuery(
    { mediaType: type === "movie" ? "MOVIE" : "TV" },
    { enabled: isOpen }
  );

  // Request mutations
  const createMovieMutation = trpc.requests.createMovie.useMutation({
    onSuccess: () => {
      onClose();
    },
  });

  const createTvMutation = trpc.requests.createTv.useMutation({
    onSuccess: () => {
      onClose();
    },
  });

  const isSubmitting = createMovieMutation.isPending || createTvMutation.isPending;
  const error = createMovieMutation.error || createTvMutation.error;

  // Reset selections when dialog opens
  useEffect(() => {
    if (isOpen) {
      setServerSelections(new Map());
      setSelectedPipelineId(null);
      setShowAdvanced(false);
      createMovieMutation.reset();
      createTvMutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- createMovieMutation and createTvMutation are stable tRPC refs
  }, [isOpen, createMovieMutation.reset, createTvMutation.reset]);

  // Auto-select default pipeline when pipelines load
  useEffect(() => {
    if (pipelines && !selectedPipelineId) {
      const defaultPipeline = pipelines.find((p: Pipeline) => p.isDefault);
      if (defaultPipeline) {
        setSelectedPipelineId(defaultPipeline.id);
      }
    }
  }, [pipelines, selectedPipelineId]);

  const toggleServer = (serverId: string) => {
    setServerSelections((prev) => {
      const next = new Map(prev);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.set(serverId, { serverId });
      }
      return next;
    });
  };

  const handleSubmit = () => {
    if (serverSelections.size === 0) return;

    // Build targets array - just serverIds
    const targets: Array<{ serverId: string }> = Array.from(serverSelections.values());

    if (type === "movie") {
      createMovieMutation.mutate({
        tmdbId,
        title,
        year,
        posterPath,
        targets,
        pipelineTemplateId: selectedPipelineId || undefined,
      });
    } else {
      createTvMutation.mutate({
        tmdbId,
        title,
        year,
        posterPath,
        targets,
        pipelineTemplateId: selectedPipelineId || undefined,
        subscribe: !seasons && !episodes,
        seasons,
        episodes,
      });
    }
  };

  const selectedServerCount = serverSelections.size;

  // Compute required resolution from selected servers
  const resolutionRank: Record<string, number> = {
    RES_4K: 4,
    RES_2K: 3,
    RES_1080P: 2,
    RES_720P: 1,
    RES_480P: 0,
  };
  const resolutionLabels: Record<string, string> = {
    RES_4K: "4K",
    RES_2K: "2K",
    RES_1080P: "1080p",
    RES_720P: "720p",
    RES_480P: "480p",
  };
  const requiredResolution = targets?.servers
    .filter((s: Server) => serverSelections.has(s.id))
    .map((s: Server) => s.maxResolution)
    .reduce(
      (highest: string | null, res: string) => {
        if (!res) return highest;
        const currentRank = highest ? (resolutionRank[highest] ?? 0) : 0;
        const newRank = resolutionRank[res] ?? 0;
        return newRank > currentRank ? res : highest;
      },
      null as string | null
    );

  const posterUrl = posterPath
    ? posterPath.startsWith("http")
      ? posterPath
      : `${TMDB_IMAGE_BASE}/w154${posterPath}`
    : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} className="w-full max-w-lg mx-4">
      <div className="bg-zinc-900/95 backdrop-blur-xl rounded border border-white/10 overflow-hidden">
        {/* Header with media info */}
        <div className="flex gap-4 p-5 border-b border-white/10">
          {posterUrl && (
            <img
              src={posterUrl}
              alt={title}
              className="w-16 h-24 object-cover rounded border border-white/10 flex-shrink-0"
            />
          )}
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-white truncate">{title}</h2>
            <p className="text-sm text-white/50">{year}</p>
            <p className="text-xs text-white/40 mt-1 uppercase">
              Request {type === "movie" ? "Movie" : "TV Show"}
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
          {targetsLoading || pipelinesLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-6 h-6 border-2 border-annex-500/30 border-t-annex-500 rounded-full" />
            </div>
          ) : !targets || targets.servers.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-white/50">No storage servers configured</p>
              <p className="text-xs text-white/30 mt-1">
                Add a storage server in Settings to make requests
              </p>
            </div>
          ) : (
            <>
              {/* Pipeline Template Selector - Advanced Only */}
              {showAdvanced && pipelines && pipelines.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-white/70 mb-3">Pipeline Template</h3>
                  <div className="space-y-2">
                    <select
                      value={selectedPipelineId || ""}
                      onChange={(e) => setSelectedPipelineId(e.target.value || null)}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded text-sm text-white focus:outline-none focus:border-annex-500/50 transition-colors"
                    >
                      {pipelines.map((pipeline: Pipeline) => (
                        <option key={pipeline.id} value={pipeline.id} className="bg-zinc-900">
                          {pipeline.name}
                          {pipeline.isDefault ? " (Default)" : ""}
                        </option>
                      ))}
                    </select>

                    {/* Pipeline Preview */}
                    {selectedPipelineId &&
                      (() => {
                        const selected = pipelines.find(
                          (p: Pipeline) => p.id === selectedPipelineId
                        );
                        return selected ? (
                          <div className="p-3 bg-white/5 border border-white/10 rounded">
                            <div className="text-xs text-white/70">{selected.description}</div>
                            <div className="text-xs text-white/40 mt-1">
                              {selected.stepCount} step{selected.stepCount !== 1 ? "s" : ""} in
                              pipeline
                            </div>
                          </div>
                        ) : null;
                      })()}
                  </div>
                </div>
              )}

              <div>
                <h3 className="text-sm font-medium text-white/70 mb-3">
                  Select Destination Servers
                </h3>
                <div className="space-y-2">
                  {targets.servers.map((server: Server) => {
                    const isSelected = serverSelections.has(server.id);

                    return (
                      <button
                        key={server.id}
                        onClick={() => toggleServer(server.id)}
                        className={`
                          flex items-center gap-3 p-3 border rounded transition-colors text-left w-full
                          ${isSelected ? "border-annex-500/50 bg-annex-500/5" : "border-white/10 bg-white/5 hover:bg-white/10"}
                        `}
                      >
                        {/* Checkbox */}
                        <div
                          className={`
                            w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0
                            transition-colors
                            ${
                              isSelected
                                ? "bg-annex-500 border-annex-500 text-white"
                                : "border-white/30"
                            }
                          `}
                        >
                          {isSelected && (
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                              <path
                                fillRule="evenodd"
                                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                clipRule="evenodd"
                              />
                            </svg>
                          )}
                        </div>

                        {/* Server info */}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-white font-medium">{server.name}</div>
                          <div className="text-xs text-white/40">
                            Max Resolution: {server.maxResolution}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Show different message based on whether selections exist */}
              {type === "tv" && !seasons && !episodes && (
                <div className="p-3 bg-white/5 border border-white/10 rounded text-sm text-white/60">
                  <p>
                    This will request all episodes and subscribe to future releases.{" "}
                    <Link
                      to={`/tv/${tmdbId}`}
                      className="text-annex-400 hover:text-annex-300 underline transition-colors"
                      onClick={onClose}
                    >
                      View full details
                    </Link>
                    {" "}for granular season/episode selection.
                  </p>
                </div>
              )}

              {type === "tv" && (seasons || episodes) && (
                <div className="p-3 bg-annex-500/10 border border-annex-500/30 rounded text-sm">
                  <p className="text-white/90 font-medium mb-1">Selected Episodes:</p>
                  <p className="text-white/70">
                    {seasons && seasons.length > 0 && (
                      <span>{seasons.length} full season{seasons.length !== 1 ? 's' : ''}</span>
                    )}
                    {episodes && episodes.length > 0 && (
                      <span>
                        {seasons && seasons.length > 0 && ', '}
                        {episodes.length} individual episode{episodes.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </p>
                </div>
              )}

              {/* Summary */}
              {selectedServerCount > 0 && (
                <div className="pt-2 border-t border-white/10 space-y-1">
                  <div className="text-xs text-white/50">
                    {selectedServerCount} server{selectedServerCount !== 1 ? "s" : ""} selected
                  </div>
                  {requiredResolution && (
                    <div className="text-xs text-annex-400">
                      Will search for:{" "}
                      <span className="font-medium">
                        {resolutionLabels[requiredResolution] || requiredResolution}+
                      </span>{" "}
                      quality releases
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Error message */}
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
              {error.message}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center gap-3 p-4 border-t border-white/10 bg-black/20">
          {/* Advanced Settings Toggle */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-xs text-white/50 hover:text-white/70 transition-colors"
          >
            <div
              className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                showAdvanced ? "bg-annex-500/20 border-annex-500/50" : "border-white/30"
              }`}
            >
              {showAdvanced && (
                <svg className="w-3 h-3 text-annex-400" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </div>
            Advanced
          </button>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={selectedServerCount === 0 || isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <div className="animate-spin w-4 h-4 border-2 border-current/30 border-t-current rounded-full mr-2" />
                  Requesting...
                </>
              ) : (
                <>Request {type === "movie" ? "Movie" : "TV Show"}</>
              )}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export { RequestDialog };
export type { RequestDialogProps };
