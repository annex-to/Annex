import { useState, useEffect } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { trpc } from "../../trpc";

interface RequestDialogProps {
  isOpen: boolean;
  onClose: () => void;
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  year: number;
  posterPath?: string | null;
}

interface ServerSelection {
  serverId: string;
  profileIds: string[]; // Empty means use server default
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
}: RequestDialogProps) {
  const [serverSelections, setServerSelections] = useState<Map<string, ServerSelection>>(new Map());
  const [expandedServer, setExpandedServer] = useState<string | null>(null);

  // Fetch available targets (servers and encoding profiles)
  const { data: targets, isLoading: targetsLoading } = trpc.requests.getAvailableTargets.useQuery(
    undefined,
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
      setExpandedServer(null);
      createMovieMutation.reset();
      createTvMutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- createMovieMutation and createTvMutation are stable tRPC refs
  }, [isOpen]);

  const toggleServer = (serverId: string) => {
    setServerSelections((prev) => {
      const next = new Map(prev);
      if (next.has(serverId)) {
        next.delete(serverId);
        if (expandedServer === serverId) {
          setExpandedServer(null);
        }
      } else {
        next.set(serverId, { serverId, profileIds: [] });
      }
      return next;
    });
  };

  const toggleServerExpanded = (serverId: string) => {
    setExpandedServer((prev) => (prev === serverId ? null : serverId));
  };

  const toggleProfile = (serverId: string, profileId: string) => {
    setServerSelections((prev) => {
      const next = new Map(prev);
      const selection = next.get(serverId);
      if (!selection) return prev;

      const profileIds = selection.profileIds.includes(profileId)
        ? selection.profileIds.filter((id) => id !== profileId)
        : [...selection.profileIds, profileId];

      next.set(serverId, { ...selection, profileIds });
      return next;
    });
  };

  const handleSubmit = () => {
    if (serverSelections.size === 0) return;

    // Build targets array - for each server, if profiles selected, create one target per profile
    // If no profiles selected, create single target with no profile (uses server default)
    const targets: Array<{ serverId: string; encodingProfileId?: string }> = [];

    serverSelections.forEach((selection) => {
      if (selection.profileIds.length === 0) {
        // No profiles selected - use server default
        targets.push({ serverId: selection.serverId });
      } else {
        // Create a target for each selected profile
        selection.profileIds.forEach((profileId) => {
          targets.push({ serverId: selection.serverId, encodingProfileId: profileId });
        });
      }
    });

    if (type === "movie") {
      createMovieMutation.mutate({
        tmdbId,
        title,
        year,
        posterPath,
        targets,
      });
    } else {
      createTvMutation.mutate({
        tmdbId,
        title,
        year,
        posterPath,
        targets,
        // TODO: Add season/episode selection for TV
      });
    }
  };

  const selectedServerCount = serverSelections.size;
  const totalProfileCount = Array.from(serverSelections.values()).reduce(
    (sum, sel) => sum + sel.profileIds.length,
    0
  );

  // Compute required resolution from selected servers
  const resolutionRank: Record<string, number> = {
    "RES_4K": 4,
    "RES_2K": 3,
    "RES_1080P": 2,
    "RES_720P": 1,
    "RES_480P": 0,
  };
  const resolutionLabels: Record<string, string> = {
    "RES_4K": "4K",
    "RES_2K": "2K",
    "RES_1080P": "1080p",
    "RES_720P": "720p",
    "RES_480P": "480p",
  };
  const requiredResolution = targets?.servers
    .filter((s) => serverSelections.has(s.id))
    .map((s) => s.maxResolution)
    .reduce((highest, res) => {
      if (!res) return highest;
      const currentRank = highest ? resolutionRank[highest] ?? 0 : 0;
      const newRank = resolutionRank[res] ?? 0;
      return newRank > currentRank ? res : highest;
    }, null as string | null);

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
          {targetsLoading ? (
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
              <div>
                <h3 className="text-sm font-medium text-white/70 mb-3">Select Destination Servers</h3>
                <div className="space-y-2">
                  {targets.servers.map((server) => {
                    const isSelected = serverSelections.has(server.id);
                    const isExpanded = expandedServer === server.id;
                    const selection = serverSelections.get(server.id);
                    const selectedProfileCount = selection?.profileIds.length ?? 0;

                    return (
                      <div
                        key={server.id}
                        className={`
                          border rounded transition-colors
                          ${isSelected ? "border-annex-500/50 bg-annex-500/5" : "border-white/10 bg-white/5"}
                        `}
                      >
                        {/* Server row */}
                        <div className="flex items-center gap-3 p-3">
                          {/* Checkbox */}
                          <button
                            onClick={() => toggleServer(server.id)}
                            className={`
                              w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0
                              transition-colors
                              ${isSelected
                                ? "bg-annex-500 border-annex-500 text-white"
                                : "border-white/30 hover:border-white/50"
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
                          </button>

                          {/* Server info */}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-white font-medium">{server.name}</div>
                            <div className="text-xs text-white/40">
                              {server.defaultProfileName
                                ? `Default: ${server.defaultProfileName}`
                                : "No default profile"}
                            </div>
                          </div>

                          {/* Profile count badge */}
                          {isSelected && selectedProfileCount > 0 && (
                            <span className="text-xs px-1.5 py-0.5 bg-annex-500/20 text-annex-400 rounded">
                              {selectedProfileCount} profile{selectedProfileCount !== 1 ? "s" : ""}
                            </span>
                          )}

                          {/* Expand button for encoding profiles */}
                          {isSelected && targets.profiles.length > 0 && (
                            <button
                              onClick={() => toggleServerExpanded(server.id)}
                              className="p-1 text-white/40 hover:text-white/70 transition-colors"
                              title="Select encoding profiles"
                            >
                              <svg
                                className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M19 9l-7 7-7-7"
                                />
                              </svg>
                            </button>
                          )}
                        </div>

                        {/* Encoding profiles dropdown */}
                        {isSelected && isExpanded && targets.profiles.length > 0 && (
                          <div className="px-3 pb-3 pt-0">
                            <div className="border-t border-white/10 pt-3">
                              <p className="text-xs text-white/40 mb-2">
                                Select encoding profiles (leave empty for server default)
                              </p>
                              <div className="flex flex-wrap gap-2">
                                {targets.profiles.map((profile) => {
                                  const isProfileSelected = selection?.profileIds.includes(profile.id);
                                  return (
                                    <button
                                      key={profile.id}
                                      onClick={() => toggleProfile(server.id, profile.id)}
                                      className={`
                                        px-2.5 py-1 text-xs rounded border transition-colors
                                        ${isProfileSelected
                                          ? "bg-annex-500/20 border-annex-500/50 text-annex-400"
                                          : "bg-white/5 border-white/10 text-white/60 hover:border-white/20 hover:text-white/80"
                                        }
                                      `}
                                    >
                                      {profile.name}
                                      {profile.isDefault && (
                                        <span className="ml-1 text-white/30">(default)</span>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Summary */}
              {selectedServerCount > 0 && (
                <div className="pt-2 border-t border-white/10 space-y-1">
                  <div className="text-xs text-white/50">
                    {selectedServerCount} server{selectedServerCount !== 1 ? "s" : ""} selected
                    {totalProfileCount > 0 && (
                      <> with {totalProfileCount} encoding profile{totalProfileCount !== 1 ? "s" : ""}</>
                    )}
                    {totalProfileCount === 0 && <> (using server defaults)</>}
                  </div>
                  {requiredResolution && (
                    <div className="text-xs text-annex-400">
                      Will search for: <span className="font-medium">{resolutionLabels[requiredResolution] || requiredResolution}+</span> quality releases
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
        <div className="flex justify-end gap-3 p-4 border-t border-white/10 bg-black/20">
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
    </Modal>
  );
}

export { RequestDialog };
export type { RequestDialogProps };
