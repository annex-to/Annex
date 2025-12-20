import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Card, EmptyState, Input, Skeleton } from "../../../components/ui";
import { trpc } from "../../../trpc";

export default function CardigannDefinitions() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [languageFilter, setLanguageFilter] = useState<string | undefined>();
  const [typeFilter, setTypeFilter] = useState<string | undefined>();

  const definitions = trpc.cardigann.listDefinitions.useQuery({
    search: search || undefined,
    language: languageFilter,
    type: typeFilter,
  });

  const syncMutation = trpc.cardigann.sync.useMutation({
    onSuccess: () => {
      definitions.refetch();
    },
  });

  const handleSync = () => {
    if (confirm("This will sync all definitions from GitHub. Continue?")) {
      syncMutation.mutate();
    }
  };

  const handleAddIndexer = (definitionId: string) => {
    navigate(`/settings/indexers/cardigann/new?definitionId=${definitionId}`);
  };

  // Extract unique languages and types for filters
  const languages = Array.from(
    new Set(definitions.data?.map((d) => d.language).filter(Boolean))
  ).sort() as string[];

  const types = Array.from(
    new Set(definitions.data?.map((d) => d.type).filter(Boolean))
  ).sort() as string[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Cardigann Indexers</h2>
          <p className="text-sm text-white/50 mt-1">
            Browse and configure indexers from Prowlarr's Cardigann definitions
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={handleSync} disabled={syncMutation.isPending}>
            {syncMutation.isPending ? "Syncing..." : "Sync Definitions"}
          </Button>
          <Button variant="ghost" onClick={() => navigate("/settings/indexers")}>
            Back to Indexers
          </Button>
        </div>
      </div>

      {syncMutation.isSuccess && (
        <Card className="p-4 bg-green-500/10 border-green-500/30">
          <p className="text-sm text-green-400">{syncMutation.data.message}</p>
        </Card>
      )}

      {syncMutation.isError && (
        <Card className="p-4 bg-red-500/10 border-red-500/30">
          <p className="text-sm text-red-400">Failed to sync: {syncMutation.error.message}</p>
        </Card>
      )}

      <div className="flex gap-4">
        <div className="flex-1">
          <Input
            placeholder="Search definitions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="bg-white/5 border border-white/10 rounded px-3 py-2 text-sm"
          value={languageFilter || ""}
          onChange={(e) => setLanguageFilter(e.target.value || undefined)}
        >
          <option value="">All Languages</option>
          {languages.map((lang) => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
        </select>
        <select
          className="bg-white/5 border border-white/10 rounded px-3 py-2 text-sm"
          value={typeFilter || ""}
          onChange={(e) => setTypeFilter(e.target.value || undefined)}
        >
          <option value="">All Types</option>
          {types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      {definitions.isLoading && (
        <div className="space-y-3">
          <Skeleton count={5} className="h-24" />
        </div>
      )}

      {definitions.data?.length === 0 && (
        <EmptyState
          title="No definitions found"
          description="Sync definitions from GitHub to get started"
        />
      )}

      {definitions.data && definitions.data.length > 0 && (
        <div className="space-y-3">
          {definitions.data.map((def) => (
            <Card key={def.id} className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="font-medium">{def.name}</h3>
                  {def.description && (
                    <p className="text-sm text-white/50 mt-1">{def.description}</p>
                  )}
                  <div className="flex gap-2 mt-2">
                    {def.language && (
                      <Badge variant="default" className="text-xs">
                        {def.language}
                      </Badge>
                    )}
                    {def.type && (
                      <Badge variant="default" className="text-xs">
                        {def.type}
                      </Badge>
                    )}
                    {def.supportsMovieSearch && (
                      <Badge variant="success" className="text-xs">
                        Movies
                      </Badge>
                    )}
                    {def.supportsTvSearch && (
                      <Badge variant="success" className="text-xs">
                        TV
                      </Badge>
                    )}
                  </div>
                  {def.links && def.links.length > 0 && (
                    <p className="text-xs text-white/40 mt-2">{def.links[0]}</p>
                  )}
                </div>
                <Button size="sm" onClick={() => handleAddIndexer(def.id)}>
                  Add Indexer
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {definitions.data && definitions.data.length > 0 && (
        <p className="text-sm text-white/40 text-center">
          Showing {definitions.data.length} definition
          {definitions.data.length === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}
