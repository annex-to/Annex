import { useState, useMemo } from "react";
import { trpc } from "../trpc";
import { Button, Input, Select, AlternativesModal } from "../components/ui";

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

type SortOption = "newest" | "oldest" | "title" | "progress" | "status";
type FilterStatus = "all" | "active" | "completed" | "failed" | "awaiting";
type FilterType = "all" | "movie" | "tv";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

const statusConfig: Record<RequestStatus, { label: string; color: string; bgColor: string; variant: "default" | "success" | "warning" | "danger" | "info" }> = {
  pending: { label: "Pending", color: "text-yellow-400", bgColor: "bg-yellow-500/20", variant: "warning" },
  searching: { label: "Searching", color: "text-blue-400", bgColor: "bg-blue-500/20", variant: "info" },
  awaiting: { label: "Awaiting", color: "text-amber-400", bgColor: "bg-amber-500/20", variant: "warning" },
  quality_unavailable: { label: "Quality N/A", color: "text-orange-400", bgColor: "bg-orange-500/20", variant: "warning" },
  downloading: { label: "Downloading", color: "text-purple-400", bgColor: "bg-purple-500/20", variant: "info" },
  encoding: { label: "Encoding", color: "text-cyan-400", bgColor: "bg-cyan-500/20", variant: "info" },
  delivering: { label: "Delivering", color: "text-teal-400", bgColor: "bg-teal-500/20", variant: "info" },
  completed: { label: "Completed", color: "text-green-400", bgColor: "bg-green-500/20", variant: "success" },
  failed: { label: "Failed", color: "text-red-400", bgColor: "bg-red-500/20", variant: "danger" },
};

const episodeStatusColors: Record<EpisodeStatus, string> = {
  pending: "bg-yellow-500/20 text-yellow-400",
  searching: "bg-blue-500/20 text-blue-400",
  awaiting: "bg-amber-500/20 text-amber-400",
  quality_unavailable: "bg-orange-500/20 text-orange-400",
  downloading: "bg-purple-500/20 text-purple-400",
  encoding: "bg-cyan-500/20 text-cyan-400",
  delivering: "bg-teal-500/20 text-teal-400",
  completed: "bg-green-500/20 text-green-400",
  failed: "bg-red-500/20 text-red-400",
  available: "bg-emerald-500/20 text-emerald-400",
};

function ProgressRing({ progress, size = 40, strokeWidth = 3 }: { progress: number; size?: number; strokeWidth?: number }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (progress / 100) * circumference;

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-white/10"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="text-annex-500 transition-all duration-300"
      />
    </svg>
  );
}

function StatusIcon({ status }: { status: RequestStatus }) {
  const isActive = ["pending", "searching", "downloading", "encoding", "delivering"].includes(status);

  if (isActive) {
    return (
      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    );
  }

  if (status === "completed") {
    return (
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
      </svg>
    );
  }

  if (status === "failed") {
    return (
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
      </svg>
    );
  }

  if (status === "awaiting" || status === "quality_unavailable") {
    return (
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
      </svg>
    );
  }

  return <div className="w-4 h-4 rounded-full border-2 border-current" />;
}

function EpisodeStatusIcon({ status }: { status: EpisodeStatus }) {
  if (status === "available") {
    return (
      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
        <path d="M10.394 2.08a1 1 0 00-.788 0l-7 3a1 1 0 000 1.84L5.25 8.051a.999.999 0 01.356-.257l4-1.714a1 1 0 11.788 1.838L7.667 9.088l1.94.831a1 1 0 00.787 0l7-3a1 1 0 000-1.838l-7-3zM3.31 9.397L5 10.12v4.102a8.969 8.969 0 00-1.05-.174 1 1 0 01-.89-.89 11.115 11.115 0 01.25-3.762zM9.3 16.573A9.026 9.026 0 007 14.935v-3.957l1.818.78a3 3 0 002.364 0l5.508-2.361a11.026 11.026 0 01.25 3.762 1 1 0 01-.89.89 8.968 8.968 0 00-5.35 2.524 1 1 0 01-1.4 0zM6 18a1 1 0 001-1v-2.065a8.935 8.935 0 00-2-.712V17a1 1 0 001 1z" />
      </svg>
    );
  }
  if (status === "completed") {
    return (
      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
      </svg>
    );
  }
  const isProcessing = ["downloading", "encoding", "delivering"].includes(status);
  if (isProcessing) {
    return (
      <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    );
  }
  return <div className="w-3 h-3 rounded-full border border-current opacity-50" />;
}

function EpisodeGrid({ requestId }: { requestId: string }) {
  const episodeStatuses = trpc.requests.getEpisodeStatuses.useQuery(
    { requestId },
    { refetchInterval: 5000 }
  );


  if (episodeStatuses.isLoading) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-6 bg-white/5 rounded w-24" />
        <div className="h-20 bg-white/5 rounded" />
      </div>
    );
  }

  if (!episodeStatuses.data || episodeStatuses.data.length === 0) {
    return (
      <div className="text-white/40 text-sm py-2">
        Episode data will appear once available.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {episodeStatuses.data.map((season) => {
        const completedCount = season.episodes.filter(
          (e) => e.status === "completed" || e.status === "available"
        ).length;
        const availableCount = season.episodes.filter((e) => e.status === "available").length;

        return (
          <div key={season.seasonNumber} className="bg-white/5 rounded border border-white/10">
            <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-white">Season {season.seasonNumber}</span>
                <span className="text-xs text-white/40">
                  {completedCount}/{season.episodes.length}
                  {availableCount > 0 && (
                    <span className="text-emerald-400 ml-1">({availableCount} in library)</span>
                  )}
                </span>
              </div>
            </div>
            <div className="p-2 flex flex-wrap gap-1">
              {season.episodes.map((episode) => {
                const canReprocess = episode.status === "completed" || episode.status === "available";
                const isProcessing = ["downloading", "encoding", "delivering"].includes(episode.status);
                const hasProgress = episode.progress != null && isProcessing;

                return (
                  <div
                    key={episode.episodeNumber}
                    className={`
                      relative flex items-center gap-1 px-2 py-1 rounded text-xs
                      ${episodeStatusColors[episode.status as EpisodeStatus] || "bg-white/5 text-white/40"}
                      ${canReprocess ? "cursor-pointer hover:ring-1 hover:ring-white/30" : "cursor-default"}
                      transition-all overflow-hidden
                    `}
                    title={`Episode ${episode.episodeNumber}: ${episode.status}${episode.error ? ` - ${episode.error}` : ""}`}
                  >
                    {hasProgress && (
                      <div
                        className="absolute inset-0 bg-white/10 transition-all"
                        style={{ width: `${episode.progress}%` }}
                      />
                    )}
                    <span className="relative flex items-center gap-1">
                      <EpisodeStatusIcon status={episode.status as EpisodeStatus} />
                      <span>{episode.episodeNumber}</span>
                      {hasProgress && (
                        <span className="text-[10px] opacity-70">{Math.round(episode.progress || 0)}%</span>
                      )}
                    </span>
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

interface RequestCardProps {
  request: {
    id: string;
    type: string;
    tmdbId: number;
    title: string;
    year: number;
    posterPath?: string | null;
    targets: {
      serverId: string;
      serverName: string;
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
  onShowAlternatives: (id: string) => void;
}

function RequestCard({ request, onShowAlternatives }: RequestCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
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


  const refreshQualityMutation = trpc.requests.refreshQualitySearch.useMutation({
    onSuccess: () => {
      utils.requests.list.invalidate();
      utils.system.queue.invalidate();
    },
  });

  const status = request.status as RequestStatus;
  const config = statusConfig[status];
  const isActive = ["pending", "searching", "downloading", "encoding", "delivering"].includes(status);
  const isAwaiting = status === "awaiting";
  const isQualityUnavailable = status === "quality_unavailable";
  const isFailed = status === "failed";
  const isDownloading = status === "downloading";

  const posterUrl = request.posterPath
    ? request.posterPath.startsWith("http")
      ? request.posterPath
      : `${TMDB_IMAGE_BASE}/w185${request.posterPath}`
    : null;

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatTime = (date: Date) => {
    return new Date(date).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <div className={`bg-white/5 border rounded overflow-hidden transition-all ${
      isActive ? "border-annex-500/30" : "border-white/10"
    }`}>
      {/* Main Card Content */}
      <div
        className="flex gap-4 p-4 cursor-pointer hover:bg-white/[0.02] transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {/* Poster */}
        <div className="flex-shrink-0 w-16 relative">
          {posterUrl ? (
            <img
              src={posterUrl}
              alt={request.title}
              className="w-16 h-24 object-cover rounded border border-white/10"
            />
          ) : (
            <div className="w-16 h-24 rounded border border-white/10 bg-white/5 flex items-center justify-center">
              <svg className="w-8 h-8 text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
              </svg>
            </div>
          )}
          {/* Type badge */}
          <div className="absolute -bottom-1 -right-1 px-1.5 py-0.5 text-[10px] font-medium bg-black/80 rounded border border-white/10 text-white/60">
            {request.type === "movie" ? "MOVIE" : "TV"}
          </div>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-medium text-white truncate">{request.title}</h3>
              <p className="text-sm text-white/40">{request.year}</p>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              {/* Progress Ring */}
              <div className="relative">
                <ProgressRing progress={request.progress} size={44} strokeWidth={3} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-xs font-medium text-white/70">
                    {Math.round(request.progress)}%
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Status Row */}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs ${config.bgColor} ${config.color}`}>
              <StatusIcon status={status} />
              <span>{config.label}</span>
            </div>
            {request.currentStep && isActive && (
              <span className="text-xs text-white/40">{request.currentStep}</span>
            )}
            {request.type === "tv" && request.requestedSeasons.length > 0 && (
              <span className="text-xs text-white/30">
                Season{request.requestedSeasons.length > 1 ? "s" : ""} {request.requestedSeasons.join(", ")}
              </span>
            )}
          </div>

          {/* Target servers (compact) */}
          <div className="mt-2 flex items-center gap-1 flex-wrap">
            {request.targets.slice(0, 2).map((target, i) => (
              <span key={i} className="text-xs px-1.5 py-0.5 bg-white/5 rounded text-white/40">
                {target.serverName}
              </span>
            ))}
            {request.targets.length > 2 && (
              <span className="text-xs text-white/30">+{request.targets.length - 2} more</span>
            )}
          </div>
        </div>

        {/* Expand indicator */}
        <div className="flex-shrink-0 self-center">
          <svg
            className={`w-5 h-5 text-white/30 transition-transform ${isExpanded ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-white/10 p-4 space-y-4 bg-black/20">
          {/* Error Message */}
          {isFailed && request.error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded">
              <div className="text-xs text-red-400/70 mb-1">Error</div>
              <div className="text-sm text-red-400">{request.error}</div>
            </div>
          )}

          {/* Awaiting Message */}
          {isAwaiting && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded">
              <div className="text-xs text-amber-400/70 mb-1">Awaiting Release</div>
              <div className="text-sm text-amber-400">
                No releases found yet. Will retry automatically.
              </div>
            </div>
          )}

          {/* Quality Unavailable */}
          {isQualityUnavailable && (
            <div className="p-3 bg-orange-500/10 border border-orange-500/20 rounded space-y-3">
              <div>
                <div className="text-xs text-orange-400/70 mb-1">Quality Unavailable</div>
                <div className="text-sm text-orange-400">
                  {request.requiredResolution
                    ? `No ${request.requiredResolution} releases found.`
                    : "No releases meeting quality requirements."}
                  {request.hasAlternatives && " Lower quality alternatives available."}
                </div>
              </div>
              <div className="flex gap-2">
                {request.hasAlternatives && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onShowAlternatives(request.id);
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

          {/* Episode Grid for TV */}
          {request.type === "tv" && (
            <div>
              <div className="text-xs text-white/40 mb-2 font-medium">Episodes</div>
              <EpisodeGrid requestId={request.id} />
            </div>
          )}

          {/* Details Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-xs text-white/40 mb-1">Target Servers</div>
              <div className="space-y-1">
                {request.targets.map((target, i) => (
                  <div key={i} className="text-white/70">
                    {target.serverName}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs text-white/40 mb-1">TMDB ID</div>
              <div className="text-white/70">{request.tmdbId}</div>
            </div>
            <div>
              <div className="text-xs text-white/40 mb-1">Created</div>
              <div className="text-white/70">{formatDate(request.createdAt)}</div>
              <div className="text-xs text-white/40">{formatTime(request.createdAt)}</div>
            </div>
            <div>
              <div className="text-xs text-white/40 mb-1">
                {request.completedAt ? "Completed" : "Updated"}
              </div>
              <div className="text-white/70">
                {formatDate(request.completedAt || request.updatedAt)}
              </div>
              <div className="text-xs text-white/40">
                {formatTime(request.completedAt || request.updatedAt)}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2 border-t border-white/5">
            {isActive && (
              <Button
                variant="danger"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  cancelMutation.mutate({ id: request.id });
                }}
                disabled={cancelMutation.isPending}
                popcorn={false}
              >
                {cancelMutation.isPending ? "Cancelling..." : "Cancel"}
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
                disabled={retryMutation.isPending}
              >
                {retryMutation.isPending ? "Retrying..." : "Retry"}
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
                disabled={cancelMutation.isPending}
                popcorn={false}
              >
                Cancel
              </Button>
            )}

            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete "${request.title}"?`)) {
                  deleteMutation.mutate({ id: request.id });
                }
              }}
              disabled={deleteMutation.isPending}
              popcorn={false}
              className="text-red-400 hover:text-red-300 hover:bg-red-500/10 ml-auto"
            >
              {deleteMutation.isPending ? "..." : "Delete"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function RequestsPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<FilterStatus>("all");
  const [typeFilter, setTypeFilter] = useState<FilterType>("all");
  const [sortBy, setSortBy] = useState<SortOption>("newest");
  const [alternativesRequestId, setAlternativesRequestId] = useState<string | null>(null);

  const requests = trpc.requests.list.useQuery(
    { limit: 100 },
    { refetchInterval: 5000 }
  );

  const filteredAndSortedRequests = useMemo(() => {
    if (!requests.data) return [];

    let filtered = requests.data;

    // Search filter
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter((r) =>
        r.title.toLowerCase().includes(searchLower) ||
        r.year.toString().includes(searchLower)
      );
    }

    // Status filter
    if (statusFilter !== "all") {
      filtered = filtered.filter((r) => {
        const status = r.status as RequestStatus;
        switch (statusFilter) {
          case "active":
            return ["pending", "searching", "downloading", "encoding", "delivering"].includes(status);
          case "completed":
            return status === "completed";
          case "failed":
            return status === "failed";
          case "awaiting":
            return status === "awaiting" || status === "quality_unavailable";
          default:
            return true;
        }
      });
    }

    // Type filter
    if (typeFilter !== "all") {
      filtered = filtered.filter((r) => r.type === typeFilter);
    }

    // Sort
    const sorted = [...filtered];
    switch (sortBy) {
      case "newest":
        sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case "oldest":
        sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        break;
      case "title":
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "progress":
        sorted.sort((a, b) => b.progress - a.progress);
        break;
      case "status": {
        const statusOrder: Record<string, number> = {
          downloading: 0,
          encoding: 1,
          delivering: 2,
          searching: 3,
          pending: 4,
          awaiting: 5,
          quality_unavailable: 6,
          failed: 7,
          completed: 8,
        };
        sorted.sort((a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99));
        break;
      }
    }

    return sorted;
  }, [requests.data, search, statusFilter, typeFilter, sortBy]);

  // Compute stats
  const stats = useMemo(() => {
    if (!requests.data) return { total: 0, active: 0, completed: 0, failed: 0, awaiting: 0 };

    return {
      total: requests.data.length,
      active: requests.data.filter((r) =>
        ["pending", "searching", "downloading", "encoding", "delivering"].includes(r.status)
      ).length,
      completed: requests.data.filter((r) => r.status === "completed").length,
      failed: requests.data.filter((r) => r.status === "failed").length,
      awaiting: requests.data.filter((r) =>
        r.status === "awaiting" || r.status === "quality_unavailable"
      ).length,
    };
  }, [requests.data]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Requests</h1>
          <p className="text-sm text-white/40 mt-1">
            {stats.total} total, {stats.active} active
          </p>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setStatusFilter("all")}
          className={`px-3 py-1.5 rounded text-sm transition-colors ${
            statusFilter === "all"
              ? "bg-white/10 text-white"
              : "bg-white/5 text-white/50 hover:text-white/70"
          }`}
        >
          All ({stats.total})
        </button>
        <button
          onClick={() => setStatusFilter("active")}
          className={`px-3 py-1.5 rounded text-sm transition-colors ${
            statusFilter === "active"
              ? "bg-annex-500/20 text-annex-400"
              : "bg-white/5 text-white/50 hover:text-white/70"
          }`}
        >
          Active ({stats.active})
        </button>
        <button
          onClick={() => setStatusFilter("awaiting")}
          className={`px-3 py-1.5 rounded text-sm transition-colors ${
            statusFilter === "awaiting"
              ? "bg-amber-500/20 text-amber-400"
              : "bg-white/5 text-white/50 hover:text-white/70"
          }`}
        >
          Awaiting ({stats.awaiting})
        </button>
        <button
          onClick={() => setStatusFilter("completed")}
          className={`px-3 py-1.5 rounded text-sm transition-colors ${
            statusFilter === "completed"
              ? "bg-green-500/20 text-green-400"
              : "bg-white/5 text-white/50 hover:text-white/70"
          }`}
        >
          Completed ({stats.completed})
        </button>
        <button
          onClick={() => setStatusFilter("failed")}
          className={`px-3 py-1.5 rounded text-sm transition-colors ${
            statusFilter === "failed"
              ? "bg-red-500/20 text-red-400"
              : "bg-white/5 text-white/50 hover:text-white/70"
          }`}
        >
          Failed ({stats.failed})
        </button>
      </div>

      {/* Filters Row */}
      <div className="flex gap-3 items-center">
        <Input
          type="text"
          placeholder="Search requests..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[150px]"
        />
        <Select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as FilterType)}
          className="w-36 flex-shrink-0"
        >
          <option value="all">All Types</option>
          <option value="movie">Movies</option>
          <option value="tv">TV Shows</option>
        </Select>
        <Select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortOption)}
          className="w-36 flex-shrink-0"
        >
          <option value="newest">Newest First</option>
          <option value="oldest">Oldest First</option>
          <option value="title">Title A-Z</option>
          <option value="progress">Progress</option>
          <option value="status">Status</option>
        </Select>
      </div>

      {/* Request List */}
      {requests.isLoading ? (
        <div className="space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-28 bg-white/5 rounded animate-pulse" />
          ))}
        </div>
      ) : filteredAndSortedRequests.length === 0 ? (
        <div className="text-center py-16 bg-white/5 rounded border border-white/10">
          {requests.data?.length === 0 ? (
            <>
              <svg className="w-12 h-12 mx-auto text-white/20 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <p className="text-white/50">No requests yet</p>
              <p className="text-sm text-white/30 mt-1">
                Search for movies or TV shows in Discover to make a request
              </p>
            </>
          ) : (
            <>
              <svg className="w-12 h-12 mx-auto text-white/20 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <p className="text-white/50">No matching requests</p>
              <p className="text-sm text-white/30 mt-1">
                Try adjusting your search or filters
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredAndSortedRequests.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              onShowAlternatives={setAlternativesRequestId}
            />
          ))}
        </div>
      )}

      {/* Alternatives Modal */}
      <AlternativesModal
        isOpen={alternativesRequestId !== null}
        onClose={() => setAlternativesRequestId(null)}
        requestId={alternativesRequestId}
      />
    </div>
  );
}
