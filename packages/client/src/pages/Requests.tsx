import { useState } from "react";
import { trpc } from "../trpc";
import { Button, Badge, AlternativesModal } from "../components/ui";

type RequestStatus =
  | "pending"
  | "searching"
  | "awaiting"
  | "quality_unavailable"
  | "downloading"
  | "encoding"
  | "delivering"
  | "completed"
  | "failed";

type EpisodeStatus = RequestStatus | "available";

const statusColors: Record<RequestStatus, string> = {
  pending: "bg-yellow-500/20 text-yellow-400",
  searching: "bg-blue-500/20 text-blue-400",
  awaiting: "bg-amber-500/20 text-amber-400",
  quality_unavailable: "bg-orange-500/20 text-orange-400",
  downloading: "bg-purple-500/20 text-purple-400",
  encoding: "bg-orange-500/20 text-orange-400",
  delivering: "bg-cyan-500/20 text-cyan-400",
  completed: "bg-green-500/20 text-green-400",
  failed: "bg-red-500/20 text-red-400",
};

const episodeStatusColors: Record<EpisodeStatus, string> = {
  ...statusColors,
  available: "bg-emerald-500/20 text-emerald-400",
};

// Episode status icons
function EpisodeStatusIcon({ status }: { status: EpisodeStatus }) {
  switch (status) {
    case "available":
      // Library icon for episodes already in library
      return (
        <svg className="w-4 h-4 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
          <path d="M4 3a2 2 0 012-2h8a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V3zm6 6a2 2 0 100-4 2 2 0 000 4zm0 2c-2.67 0-8 1.34-8 4v1h16v-1c0-2.66-5.33-4-8-4z" />
        </svg>
      );
    case "completed":
      return (
        <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      );
    case "failed":
      return (
        <svg className="w-4 h-4 text-red-400" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      );
    case "downloading":
    case "encoding":
    case "delivering":
      return (
        <svg className="w-4 h-4 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );
    case "awaiting":
      return (
        <svg className="w-4 h-4 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
        </svg>
      );
    case "quality_unavailable":
      return (
        <svg className="w-4 h-4 text-orange-400" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
      );
    default:
      return (
        <div className="w-4 h-4 rounded-full border-2 border-surface-500" />
      );
  }
}

const statusVariants: Record<RequestStatus, "default" | "success" | "warning" | "danger" | "info"> = {
  pending: "warning",
  searching: "info",
  awaiting: "warning",
  quality_unavailable: "warning",
  downloading: "info",
  encoding: "warning",
  delivering: "info",
  completed: "success",
  failed: "danger",
};

// Chevron SVG components
// Episode status table for TV requests
function EpisodeStatusTable({ requestId }: { requestId: string }) {
  const utils = trpc.useUtils();
  const episodeStatuses = trpc.requests.getEpisodeStatuses.useQuery(
    { requestId },
    { refetchInterval: 5000 } // Refresh every 5 seconds for live progress
  );

  const reprocessEpisodeMutation = trpc.requests.reprocessEpisode.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      utils.requests.getEpisodeStatuses.invalidate({ requestId });
    },
  });

  const reprocessSeasonMutation = trpc.requests.reprocessSeason.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      utils.requests.getEpisodeStatuses.invalidate({ requestId });
    },
  });

  const handleReprocessEpisode = (episodeId: string, episodeNum: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Reprocess episode ${episodeNum}? This will re-encode and re-deliver the episode.`)) {
      reprocessEpisodeMutation.mutate({ episodeId });
    }
  };

  const handleReprocessSeason = (seasonNumber: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Reprocess all completed episodes in Season ${seasonNumber}?`)) {
      reprocessSeasonMutation.mutate({ requestId, seasonNumber });
    }
  };

  if (episodeStatuses.isLoading) {
    return (
      <div className="space-y-2">
        <div className="text-surface-400 text-sm font-medium">Episodes</div>
        <div className="animate-pulse space-y-2">
          <div className="h-8 bg-surface-700 rounded w-1/4" />
          <div className="h-24 bg-surface-700 rounded" />
        </div>
      </div>
    );
  }

  if (episodeStatuses.isError) {
    return (
      <div className="text-red-400 text-sm py-2">
        Failed to load episode data: {episodeStatuses.error?.message}
      </div>
    );
  }

  if (!episodeStatuses.data || episodeStatuses.data.length === 0) {
    return (
      <div className="text-surface-500 text-sm py-2">
        No episode data available yet. Episode info will appear once TMDB data is fetched.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-surface-400 text-sm font-medium">Episodes</div>
      {episodeStatuses.data.map((season) => {
        const completedOrAvailable = season.episodes.filter(
          e => e.status === "completed" || e.status === "available"
        ).length;
        const availableCount = season.episodes.filter(e => e.status === "available").length;
        const hasReprocessable = season.episodes.some(
          e => e.status === "completed" || e.status === "available"
        );

        return (
          <div key={season.seasonNumber} className="bg-surface-700/30 rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-surface-700/50 border-b border-surface-600 flex items-center justify-between">
              <div>
                <span className="font-medium">Season {season.seasonNumber}</span>
                <span className="text-surface-400 ml-2 text-sm">
                  ({completedOrAvailable}/{season.episodes.length} done
                  {availableCount > 0 && <span className="text-emerald-400">, {availableCount} in library</span>})
                </span>
              </div>
              {hasReprocessable && (
                <button
                  onClick={(e) => handleReprocessSeason(season.seasonNumber, e)}
                  disabled={reprocessSeasonMutation.isPending}
                  className="text-xs px-2 py-1 rounded bg-surface-600 hover:bg-surface-500 text-surface-300 hover:text-white transition-colors disabled:opacity-50"
                  title="Reprocess all completed/available episodes in this season"
                >
                  {reprocessSeasonMutation.isPending ? "..." : "Reprocess Season"}
                </button>
              )}
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-1 p-2">
              {season.episodes.map((episode) => {
                const isDownloading = episode.status === "downloading" || episode.status === "encoding" || episode.status === "delivering";
                const hasProgress = episode.progress !== null && episode.progress !== undefined;
                const canReprocess = episode.status === "completed" || episode.status === "available";

                // Build tooltip content
                let tooltipContent = `Episode ${episode.episodeNumber}: `;
                if (episode.status === "available") {
                  tooltipContent += "Already in library (click to reprocess)";
                } else if (episode.status === "completed") {
                  tooltipContent += "Completed (click to reprocess)";
                } else {
                  tooltipContent += episode.status;
                  if (hasProgress) {
                    tooltipContent += ` (${episode.progress?.toFixed(1)}%)`;
                  }
                  if (episode.releaseName) {
                    tooltipContent += `\n${episode.releaseName}`;
                  }
                  if (episode.error) {
                    tooltipContent += `\nError: ${episode.error}`;
                  }
                }

                return (
                  <div
                    key={episode.episodeNumber}
                    onClick={canReprocess && episode.id ? (e) => handleReprocessEpisode(episode.id!, episode.episodeNumber, e) : undefined}
                    className={`relative flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs overflow-hidden ${
                      episodeStatusColors[episode.status as EpisodeStatus] || "bg-surface-600 text-surface-400"
                    } ${canReprocess ? "cursor-pointer hover:ring-2 hover:ring-white/30" : ""}`}
                    title={tooltipContent}
                  >
                    {/* Progress bar background for downloading episodes */}
                    {isDownloading && hasProgress && (
                      <div
                        className="absolute inset-0 bg-blue-500/30 transition-all duration-300"
                        style={{ width: `${episode.progress}%` }}
                      />
                    )}
                    <div className="relative flex items-center gap-1">
                      <EpisodeStatusIcon status={episode.status as EpisodeStatus} />
                      <span>{episode.episodeNumber}</span>
                      {isDownloading && hasProgress && (
                        <span className="text-[10px] opacity-75">{Math.round(episode.progress || 0)}%</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

interface RequestRowProps {
  request: {
    id: string;
    type: string;
    tmdbId: number;
    title: string;
    year: number;
    targets: {
      serverId: string;
      serverName: string;
      encodingProfileId: string | undefined;
      encodingProfileName: string;
    }[];
    requestedSeasons: number[];
    requestedEpisodes: { season: number; episode: number }[] | null;
    status: string;
    progress: number;
    currentStep: string | null;
    error: string | null;
    requiredResolution: string | null;
    hasAlternatives: boolean;
    createdAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
  };
  isExpanded: boolean;
  onToggle: () => void;
  onShowAlternatives?: (requestId: string) => void;
}

function RequestRow({ request, isExpanded, onToggle, onShowAlternatives }: RequestRowProps) {
  const utils = trpc.useUtils();
  const cancelMutation = trpc.requests.cancel.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      utils.system.queue.invalidate();
    },
  });
  const retryMutation = trpc.requests.retry.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      utils.system.queue.invalidate();
    },
  });
  const deleteMutation = trpc.requests.delete.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      utils.system.queue.invalidate();
    },
  });
  const reprocessMutation = trpc.requests.reprocess.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      utils.system.queue.invalidate();
    },
  });

  const refreshQualityMutation = trpc.requests.refreshQualitySearch.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      utils.system.queue.invalidate();
    },
  });

  const status = request.status as RequestStatus;
  const isActive = ["pending", "searching", "downloading", "encoding", "delivering"].includes(status);
  const isAwaiting = status === "awaiting";
  const isQualityUnavailable = status === "quality_unavailable";
  const isFailed = status === "failed";
  const isCompleted = status === "completed";
  const isDownloading = status === "downloading";

  return (
    <>
      {/* Main row */}
      <tr
        className={`border-b border-surface-700/50 hover:bg-surface-700/30 cursor-pointer transition-colors ${
          isExpanded ? "bg-surface-700/20" : ""
        }`}
        onClick={onToggle}
      >
        <td className="px-4 py-3 w-8">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-surface-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-surface-400" />
          )}
        </td>
        <td className="px-4 py-3">
          <div className="font-medium">{request.title}</div>
          <div className="text-sm text-surface-500">{request.year}</div>
        </td>
        <td className="px-4 py-3 text-surface-400">
          {request.type === "movie" ? "Movie" : "TV Show"}
        </td>
        <td className="px-4 py-3">
          <Badge variant={statusVariants[status]}>
            {status}
          </Badge>
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="w-24 h-2 bg-surface-700 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  isCompleted ? "bg-green-500" : isFailed ? "bg-red-500" : "bg-annex-500"
                }`}
                style={{ width: `${request.progress}%` }}
              />
            </div>
            <span className="text-xs text-surface-500 w-10">
              {request.progress.toFixed(0)}%
            </span>
          </div>
        </td>
        <td className="px-4 py-3 text-surface-400 text-sm">
          {new Date(request.createdAt).toLocaleDateString()}
        </td>
      </tr>

      {/* Expanded detail row */}
      {isExpanded && (
        <tr className="bg-surface-800/50">
          <td colSpan={6} className="px-4 py-4">
            <div className="pl-8 space-y-4">
              {/* Error message */}
              {isFailed && request.error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded p-3">
                  <div className="text-xs text-red-400 font-medium mb-1">Error</div>
                  <div className="text-sm text-red-300">{request.error}</div>
                </div>
              )}

              {/* Awaiting release message */}
              {isAwaiting && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3">
                  <div className="text-xs text-amber-400 font-medium mb-1">Awaiting Release</div>
                  <div className="text-sm text-amber-300">
                    No releases found yet. This request will be retried automatically on schedule.
                  </div>
                </div>
              )}

              {/* Quality unavailable message */}
              {isQualityUnavailable && (
                <div className="bg-orange-500/10 border border-orange-500/30 rounded p-3 space-y-3">
                  <div>
                    <div className="text-xs text-orange-400 font-medium mb-1">Quality Unavailable</div>
                    <div className="text-sm text-orange-300">
                      {request.requiredResolution ? (
                        <>No {request.requiredResolution} releases found. {request.hasAlternatives && "Lower quality releases are available."}</>
                      ) : (
                        <>No releases meeting quality requirements found.</>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {request.hasAlternatives && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          onShowAlternatives?.(request.id);
                        }}
                      >
                        View Alternatives
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        refreshQualityMutation.mutate({ id: request.id });
                      }}
                      disabled={refreshQualityMutation.isPending}
                    >
                      {refreshQualityMutation.isPending ? "Searching..." : "Re-search"}
                    </Button>
                  </div>
                </div>
              )}

              {/* Current step for active requests */}
              {isActive && request.currentStep && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-surface-400">Current step:</span>
                  <Badge variant="info">{request.currentStep}</Badge>
                </div>
              )}

              {/* Episode Status Table for TV shows */}
              {request.type === "tv" && (
                <EpisodeStatusTable requestId={request.id} />
              )}

              {/* Grid of details */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                {/* Target servers */}
                <div>
                  <div className="text-surface-500 mb-1">Target Servers</div>
                  <div className="space-y-1">
                    {request.targets.map((target, i) => (
                      <div key={i} className="text-surface-300">
                        {target.serverName}
                        <span className="text-surface-500 ml-1">
                          ({target.encodingProfileName})
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* TV-specific: Seasons/Episodes - just show summary in the grid */}
                {request.type === "tv" && (
                  <div>
                    <div className="text-surface-500 mb-1">Requested</div>
                    {request.requestedSeasons.length > 0 ? (
                      <div className="text-surface-300">
                        {request.requestedSeasons.length === 1
                          ? `Season ${request.requestedSeasons[0]}`
                          : `Seasons ${request.requestedSeasons.join(", ")}`}
                      </div>
                    ) : request.requestedEpisodes && request.requestedEpisodes.length > 0 ? (
                      <div className="text-surface-300">
                        {request.requestedEpisodes.map((ep) => `S${ep.season}E${ep.episode}`).join(", ")}
                      </div>
                    ) : (
                      <div className="text-surface-300">All episodes</div>
                    )}
                  </div>
                )}

                {/* TMDB ID */}
                <div>
                  <div className="text-surface-500 mb-1">TMDB ID</div>
                  <div className="text-surface-300">{request.tmdbId}</div>
                </div>

                {/* Timestamps */}
                <div>
                  <div className="text-surface-500 mb-1">Created</div>
                  <div className="text-surface-300">
                    {new Date(request.createdAt).toLocaleString()}
                  </div>
                </div>

                {request.completedAt && (
                  <div>
                    <div className="text-surface-500 mb-1">Completed</div>
                    <div className="text-surface-300">
                      {new Date(request.completedAt).toLocaleString()}
                    </div>
                  </div>
                )}

                {!request.completedAt && request.updatedAt && (
                  <div>
                    <div className="text-surface-500 mb-1">Last Updated</div>
                    <div className="text-surface-300">
                      {new Date(request.updatedAt).toLocaleString()}
                    </div>
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex gap-2 pt-2">
                {isActive && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      cancelMutation.mutate({ id: request.id });
                    }}
                    disabled={cancelMutation.isLoading}
                    popcorn={false}
                  >
                    {cancelMutation.isLoading ? "Cancelling..." : "Cancel"}
                  </Button>
                )}

                {(isFailed || isAwaiting || isDownloading) && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      retryMutation.mutate({ id: request.id });
                    }}
                    disabled={retryMutation.isLoading}
                  >
                    {retryMutation.isLoading ? "Retrying..." : isAwaiting ? "Retry Now" : "Retry"}
                  </Button>
                )}

                {isAwaiting && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      cancelMutation.mutate({ id: request.id });
                    }}
                    disabled={cancelMutation.isLoading}
                    popcorn={false}
                  >
                    {cancelMutation.isLoading ? "Cancelling..." : "Cancel"}
                  </Button>
                )}

                {isCompleted && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Reprocess "${request.title}"? This will re-encode and re-deliver the media.`)) {
                        reprocessMutation.mutate({ id: request.id });
                      }
                    }}
                    disabled={reprocessMutation.isPending}
                  >
                    {reprocessMutation.isPending ? "Reprocessing..." : "Reprocess"}
                  </Button>
                )}

                {/* Delete button - always available */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete request "${request.title}"? This will cancel any running jobs.`)) {
                      deleteMutation.mutate({ id: request.id });
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  popcorn={false}
                  className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                >
                  {deleteMutation.isPending ? "Deleting..." : "Delete"}
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function RequestsPage() {
  const requests = trpc.requests.list.useQuery({ limit: 50 });
  const queue = trpc.system.queue.useQuery();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [alternativesRequestId, setAlternativesRequestId] = useState<string | null>(null);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="space-y-8">
      {/* Active Queue */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Active Queue</h2>
        {queue.isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-16 bg-surface-800 rounded-lg animate-pulse" />
            ))}
          </div>
        )}

        {queue.data?.length === 0 && (
          <div className="text-center py-8 text-surface-500 bg-surface-800/50 rounded-lg">
            No active requests in queue
          </div>
        )}

        {queue.data && queue.data.length > 0 && (
          <div className="space-y-2">
            {queue.data.map((item) => (
              <div
                key={item.requestId}
                className="bg-surface-800 rounded-lg p-4 flex items-center gap-4"
              >
                <div className="w-8 h-8 rounded-full bg-surface-700 flex items-center justify-center text-sm font-medium">
                  {item.position}
                </div>
                <div className="flex-1">
                  <div className="font-medium">{item.title}</div>
                  <div className="text-sm text-surface-400">
                    {item.type === "movie" ? "Movie" : "TV Show"}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-32">
                    <div className="h-2 bg-surface-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-annex-500 transition-all duration-300"
                        style={{ width: `${item.progress}%` }}
                      />
                    </div>
                    <div className="text-xs text-surface-500 mt-1 text-right">
                      {item.progress.toFixed(0)}%
                    </div>
                  </div>
                  <Badge variant={statusVariants[item.status as RequestStatus] || "default"}>
                    {item.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* All Requests */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">All Requests</h2>
          {requests.data && requests.data.length > 0 && (
            <span className="text-sm text-surface-500">
              Click a row to expand details
            </span>
          )}
        </div>

        {requests.isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-16 bg-surface-800 rounded-lg animate-pulse" />
            ))}
          </div>
        )}

        {requests.data?.length === 0 && (
          <div className="text-center py-12 text-surface-500 bg-surface-800/50 rounded-lg">
            <p>No requests yet</p>
            <p className="text-sm mt-2">
              Search for movies or TV shows in Discover to make a request
            </p>
          </div>
        )}

        {requests.data && requests.data.length > 0 && (
          <div className="bg-surface-800 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-surface-700">
                  <th className="w-8"></th>
                  <th className="text-left px-4 py-3 text-surface-400 font-medium">Title</th>
                  <th className="text-left px-4 py-3 text-surface-400 font-medium">Type</th>
                  <th className="text-left px-4 py-3 text-surface-400 font-medium">Status</th>
                  <th className="text-left px-4 py-3 text-surface-400 font-medium">Progress</th>
                  <th className="text-left px-4 py-3 text-surface-400 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {requests.data.map((req) => (
                  <RequestRow
                    key={req.id}
                    request={req}
                    isExpanded={expandedIds.has(req.id)}
                    onToggle={() => toggleExpanded(req.id)}
                    onShowAlternatives={setAlternativesRequestId}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Alternatives Modal */}
      <AlternativesModal
        isOpen={alternativesRequestId !== null}
        onClose={() => setAlternativesRequestId(null)}
        requestId={alternativesRequestId}
      />
    </div>
  );
}
