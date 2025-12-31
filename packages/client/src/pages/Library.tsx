import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, Input, LibraryCard, ToggleGroup } from "../components/ui";
import { trpc } from "../trpc";

type MediaType = "all" | "movie" | "tv";
type SortBy = "SortName" | "DateCreated" | "PremiereDate" | "CommunityRating";
type SortOrder = "Ascending" | "Descending";

interface Server {
  id: string;
  name: string;
  mediaServerType: string | null;
}

export default function LibraryPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Parse state from URL (with defaults)
  const selectedServerId = searchParams.get("server") || null;
  const mediaType = (searchParams.get("type") as MediaType) || "all";
  const sortBy = (searchParams.get("sortBy") as SortBy) || "SortName";
  const sortOrder = (searchParams.get("order") as SortOrder) || "Ascending";
  const search = searchParams.get("search") || "";
  const page = parseInt(searchParams.get("page") || "1", 10);

  // Local state for search input (before submit)
  const [searchInput, setSearchInput] = useState(search);
  const limit = 24;

  // Get list of servers with media server configured
  const { data: servers, isLoading: isLoadingServers } =
    trpc.servers.listWithMediaServer.useQuery();

  // Auto-select first server when loaded
  useEffect(() => {
    if (servers && servers.length > 0 && !selectedServerId) {
      setSearchParams(
        (prev) => {
          const newParams = new URLSearchParams(prev);
          newParams.set("server", servers[0].id);
          return newParams;
        },
        { replace: true }
      );
    }
  }, [servers, selectedServerId, setSearchParams]);

  // Sync search input with URL param (for browser back/forward)
  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  // Get stats for selected server
  const { data: stats } = trpc.servers.mediaStats.useQuery(
    { serverId: selectedServerId || "" },
    { enabled: !!selectedServerId }
  );

  // Get library media for selected server
  const { data: mediaData, isLoading: isLoadingMedia } = trpc.servers.browseMedia.useQuery(
    {
      serverId: selectedServerId || "",
      type: mediaType === "all" ? undefined : mediaType,
      page,
      limit,
      sortBy,
      sortOrder,
      search: search || undefined,
    },
    { enabled: !!selectedServerId }
  );

  // Update URL params helper
  const updateParams = (updates: Record<string, string | null>) => {
    setSearchParams(
      (prev) => {
        const newParams = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(updates)) {
          if (value === null || value === "") {
            newParams.delete(key);
          } else {
            newParams.set(key, value);
          }
        }
        return newParams;
      },
      { replace: false }
    );
  };

  // Handle search submit
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    updateParams({ search: searchInput, page: "1" });
  };

  // Clear search
  const clearSearch = () => {
    setSearchInput("");
    updateParams({ search: null, page: "1" });
  };

  // Handle server change
  const handleServerChange = (serverId: string) => {
    setSearchInput("");
    updateParams({ server: serverId, page: "1", search: null });
  };

  // Loading state
  if (isLoadingServers) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-annex-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // No servers configured
  if (!servers || servers.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Library</h1>
        </div>

        <EmptyState
          title="No media servers configured"
          description="Add a storage server with Emby or Plex integration in Settings to browse your library"
          icon={
            <svg className="w-16 h-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              />
            </svg>
          }
        />
      </div>
    );
  }

  const selectedServer = servers.find((s: Server) => s.id === selectedServerId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Library</h1>
          <p className="text-white/50 text-sm mt-1">Browse your media library</p>
        </div>

        {/* Stats */}
        {stats && (
          <div className="flex gap-4">
            <Card className="px-4 py-2">
              <div className="text-2xl font-bold text-annex-400">{stats.movieCount}</div>
              <div className="text-xs text-white/50">Movies</div>
            </Card>
            <Card className="px-4 py-2">
              <div className="text-2xl font-bold text-annex-400">{stats.tvShowCount}</div>
              <div className="text-xs text-white/50">TV Shows</div>
            </Card>
            <Card className="px-4 py-2">
              <div className="text-2xl font-bold text-annex-400">{stats.episodeCount}</div>
              <div className="text-xs text-white/50">Episodes</div>
            </Card>
          </div>
        )}
      </div>

      {/* Server Selector */}
      {servers.length > 1 && (
        <div className="flex items-center gap-3">
          <span className="text-white/50 text-sm">Server:</span>
          <div className="flex gap-2">
            {servers.map((server: Server) => (
              <button
                key={server.id}
                onClick={() => handleServerChange(server.id)}
                className={`
                  px-3 py-1.5 rounded text-sm font-medium transition-colors
                  flex items-center gap-2
                  ${
                    selectedServerId === server.id
                      ? "bg-annex-500/20 text-annex-400 border border-annex-500/30"
                      : "bg-white/5 text-white/60 border border-white/10 hover:bg-white/10 hover:text-white"
                  }
                `}
              >
                {server.mediaServerType === "emby" ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M11.041 2.008c-.073.007-.134.073-.134.148v9.66l-8.09-4.67a.15.15 0 0 0-.224.13v9.448a.15.15 0 0 0 .224.13l8.09-4.67v9.66a.15.15 0 0 0 .224.13l10.276-5.93a.15.15 0 0 0 0-.26L11.131 2.008a.15.15 0 0 0-.09 0z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.383 0 0 5.383 0 12s5.383 12 12 12 12-5.383 12-12S18.617 0 12 0zm4.707 15.707a1 1 0 0 1-1.414 0l-4-4a1 1 0 0 1 0-1.414l4-4a1 1 0 0 1 1.414 1.414L13.414 11H18a1 1 0 1 1 0 2h-4.586l3.293 3.293a1 1 0 0 1 0 1.414z" />
                  </svg>
                )}
                {server.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Single server badge */}
      {servers.length === 1 && selectedServer && (
        <div className="flex items-center gap-2">
          <Badge variant="info">
            {selectedServer.mediaServerType === "emby" ? "Emby" : "Plex"}: {selectedServer.name}
          </Badge>
        </div>
      )}

      {/* Filters Bar */}
      <div className="flex flex-col sm:flex-row gap-4">
        {/* Search */}
        <form onSubmit={handleSearch} className="flex gap-2 flex-1 max-w-md">
          <Input
            type="text"
            placeholder="Search library..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
          {search && (
            <Button type="button" variant="ghost" onClick={clearSearch}>
              Clear
            </Button>
          )}
        </form>

        {/* Type filter */}
        <ToggleGroup
          value={mediaType}
          onChange={(v) => {
            updateParams({ type: v === "all" ? null : v, page: "1" });
          }}
          options={[
            { value: "all", label: "All" },
            { value: "movie", label: "Movies" },
            { value: "tv", label: "TV Shows" },
          ]}
        />

        {/* Sort */}
        <div className="flex gap-2">
          <select
            value={sortBy}
            onChange={(e) => {
              updateParams({
                sortBy: e.target.value === "SortName" ? null : e.target.value,
                page: "1",
              });
            }}
            className="bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-annex-500/50"
          >
            <option value="SortName">Name</option>
            <option value="DateCreated">Date Added</option>
            <option value="PremiereDate">Release Date</option>
            <option value="CommunityRating">Rating</option>
          </select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              updateParams({
                order: sortOrder === "Ascending" ? "Descending" : null,
                page: "1",
              });
            }}
            className="px-2"
          >
            {sortOrder === "Ascending" ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 15l7-7 7 7"
                />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            )}
          </Button>
        </div>
      </div>

      {/* Active filters */}
      {search && (
        <div className="flex items-center gap-2">
          <span className="text-white/50 text-sm">Searching for:</span>
          <Badge variant="info">{search}</Badge>
        </div>
      )}

      {/* Media Grid */}
      {isLoadingMedia ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-annex-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : mediaData?.items.length === 0 ? (
        <EmptyState
          title={search ? "No results found" : "Library is empty"}
          description={
            search
              ? `No media found matching "${search}"`
              : "This server's library appears to be empty"
          }
          icon={
            <svg className="w-16 h-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          }
        />
      ) : (
        <>
          {/* Results count */}
          <div className="text-white/50 text-sm">
            Showing {(page - 1) * limit + 1}-{Math.min(page * limit, mediaData?.totalItems || 0)} of{" "}
            {mediaData?.totalItems} items
          </div>

          {/* Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {mediaData?.items.map((item) => (
              <LibraryCard
                key={item.id}
                id={item.id}
                title={item.title}
                type={item.type}
                year={item.year}
                posterUrl={item.posterUrl}
                rating={item.rating}
                quality={item.quality}
                genres={item.genres}
                tmdbId={item.tmdbId}
                overview={item.overview}
              />
            ))}
          </div>

          {/* Pagination */}
          {mediaData && mediaData.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-4">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateParams({ page: "1" })}
                disabled={page === 1}
              >
                First
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateParams({ page: String(page - 1) })}
                disabled={page === 1}
              >
                Previous
              </Button>
              <span className="text-white/60 px-4">
                Page {page} of {mediaData.totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateParams({ page: String(page + 1) })}
                disabled={page >= mediaData.totalPages}
              >
                Next
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateParams({ page: String(mediaData.totalPages) })}
                disabled={page >= mediaData.totalPages}
              >
                Last
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
