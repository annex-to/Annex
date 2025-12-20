import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, Input, Label, Skeleton } from "../../../components/ui";
import { trpc } from "../../../trpc";

export default function CardigannIndexerForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const definitionId = searchParams.get("definitionId") || "";
  const indexerId = searchParams.get("indexerId");

  const [formData, setFormData] = useState({
    name: "",
    settings: {} as Record<string, string>,
    categoriesMovies: [] as number[],
    categoriesTv: [] as number[],
    priority: 50,
    enabled: true,
    rateLimitEnabled: false,
    rateLimitMax: 10,
    rateLimitWindowSecs: 60,
  });

  const definition = trpc.cardigann.getDefinition.useQuery(
    { id: definitionId },
    { enabled: !!definitionId }
  );

  const existingIndexer = trpc.cardigann.getIndexer.useQuery(
    { id: indexerId || "" },
    { enabled: !!indexerId }
  );

  const createMutation = trpc.cardigann.createIndexer.useMutation({
    onSuccess: () => {
      navigate("/settings/indexers");
    },
  });

  const updateMutation = trpc.cardigann.updateIndexer.useMutation({
    onSuccess: () => {
      navigate("/settings/indexers");
    },
  });

  // Load existing indexer data
  useEffect(() => {
    if (existingIndexer.data) {
      setFormData({
        name: existingIndexer.data.name,
        settings: (existingIndexer.data.settings as Record<string, string>) || {},
        categoriesMovies: existingIndexer.data.categoriesMovies,
        categoriesTv: existingIndexer.data.categoriesTv,
        priority: existingIndexer.data.priority,
        enabled: existingIndexer.data.enabled,
        rateLimitEnabled: existingIndexer.data.rateLimitEnabled,
        rateLimitMax: existingIndexer.data.rateLimitMax || 10,
        rateLimitWindowSecs: existingIndexer.data.rateLimitWindowSecs || 60,
      });
    }
  }, [existingIndexer.data]);

  // Set default name from definition
  useEffect(() => {
    if (definition.data && !indexerId) {
      setFormData((prev) => ({
        ...prev,
        name: definition.data.definition.name,
      }));
    }
  }, [definition.data, indexerId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (indexerId) {
      updateMutation.mutate({
        id: indexerId,
        ...formData,
      });
    } else {
      createMutation.mutate({
        definitionId,
        ...formData,
      });
    }
  };

  const handleSettingChange = (key: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        [key]: value,
      },
    }));
  };

  if (definition.isLoading || existingIndexer.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton count={1} className="h-8 w-64" />
        <Skeleton count={5} className="h-32" />
      </div>
    );
  }

  if (!definition.data) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold">Definition Not Found</h2>
        <Button onClick={() => navigate("/settings/indexers/cardigann")}>
          Back to Definitions
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{indexerId ? "Edit" : "Add"} Cardigann Indexer</h2>
          <p className="text-sm text-white/50 mt-1">{definition.data.definition.name}</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={() => navigate("/settings/indexers")}>
            Cancel
          </Button>
          <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
            {createMutation.isPending || updateMutation.isPending
              ? "Saving..."
              : indexerId
                ? "Update Indexer"
                : "Create Indexer"}
          </Button>
        </div>
      </div>

      {(createMutation.isError || updateMutation.isError) && (
        <Card className="p-4 bg-red-500/10 border-red-500/30">
          <p className="text-sm text-red-400">
            {createMutation.error?.message || updateMutation.error?.message}
          </p>
        </Card>
      )}

      <Card className="p-5 space-y-4">
        <h3 className="font-medium text-lg">Basic Information</h3>

        <div>
          <Label htmlFor="name">Indexer Name</Label>
          <Input
            id="name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
          />
          <p className="text-xs text-white/40 mt-1">A friendly name to identify this indexer</p>
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <Label htmlFor="priority">Priority</Label>
            <Input
              id="priority"
              type="number"
              value={formData.priority}
              onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value, 10) })}
              min={0}
              max={100}
              required
            />
          </div>
          <div className="flex items-center gap-2 pt-6">
            <input
              type="checkbox"
              id="enabled"
              checked={formData.enabled}
              onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
            />
            <Label htmlFor="enabled">Enabled</Label>
          </div>
        </div>
      </Card>

      {definition.data.definition.settings && definition.data.definition.settings.length > 0 && (
        <Card className="p-5 space-y-4">
          <h3 className="font-medium text-lg">Indexer Settings</h3>
          <p className="text-sm text-white/50">
            Configure credentials and settings for this indexer
          </p>

          {definition.data.definition.settings.map((setting) => (
            <div key={setting.name}>
              <Label htmlFor={setting.name}>{setting.label}</Label>
              <Input
                id={setting.name}
                type={setting.type === "password" ? "password" : "text"}
                value={formData.settings[setting.name] || ""}
                onChange={(e) => handleSettingChange(setting.name, e.target.value)}
                placeholder={setting.default?.toString()}
              />
            </div>
          ))}
        </Card>
      )}

      <Card className="p-5 space-y-4">
        <h3 className="font-medium text-lg">Categories</h3>
        <p className="text-sm text-white/50">Torznab category IDs to search (comma-separated)</p>

        {definition.data.definition.caps?.modes?.["movie-search"] && (
          <div>
            <Label htmlFor="categoriesMovies">Movie Categories</Label>
            <Input
              id="categoriesMovies"
              value={formData.categoriesMovies.join(", ")}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  categoriesMovies: e.target.value
                    .split(",")
                    .map((c) => parseInt(c.trim(), 10))
                    .filter((c) => !Number.isNaN(c)),
                })
              }
              placeholder="2000, 2010, 2020"
            />
            <p className="text-xs text-white/40 mt-1">
              Common: 2000 (Movies), 2010 (Movies/Foreign), 2020 (Movies/Other)
            </p>
          </div>
        )}

        {definition.data.definition.caps?.modes?.["tv-search"] && (
          <div>
            <Label htmlFor="categoriesTv">TV Categories</Label>
            <Input
              id="categoriesTv"
              value={formData.categoriesTv.join(", ")}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  categoriesTv: e.target.value
                    .split(",")
                    .map((c) => parseInt(c.trim(), 10))
                    .filter((c) => !Number.isNaN(c)),
                })
              }
              placeholder="5000, 5030, 5040"
            />
            <p className="text-xs text-white/40 mt-1">
              Common: 5000 (TV), 5030 (TV/SD), 5040 (TV/HD)
            </p>
          </div>
        )}

        {definition.data.definition.caps?.categorymappings && (
          <div className="mt-3">
            <p className="text-xs text-white/50 mb-2">Available categories:</p>
            <div className="flex flex-wrap gap-2">
              {definition.data.definition.caps.categorymappings.map((cat) => (
                <Badge key={cat.id} variant="default" className="text-xs">
                  {cat.id}: {cat.desc} ({cat.cat})
                </Badge>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card className="p-5 space-y-4">
        <h3 className="font-medium text-lg">Rate Limiting</h3>
        <p className="text-sm text-white/50">Limit API requests to avoid hitting rate limits</p>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="rateLimitEnabled"
            checked={formData.rateLimitEnabled}
            onChange={(e) => setFormData({ ...formData, rateLimitEnabled: e.target.checked })}
          />
          <Label htmlFor="rateLimitEnabled">Enable rate limiting</Label>
        </div>

        {formData.rateLimitEnabled && (
          <div className="flex gap-4">
            <div className="flex-1">
              <Label htmlFor="rateLimitMax">Max Requests</Label>
              <Input
                id="rateLimitMax"
                type="number"
                value={formData.rateLimitMax}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    rateLimitMax: parseInt(e.target.value, 10),
                  })
                }
                min={1}
              />
            </div>
            <div className="flex-1">
              <Label htmlFor="rateLimitWindowSecs">Window (seconds)</Label>
              <Input
                id="rateLimitWindowSecs"
                type="number"
                value={formData.rateLimitWindowSecs}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    rateLimitWindowSecs: parseInt(e.target.value, 10),
                  })
                }
                min={1}
              />
            </div>
          </div>
        )}
      </Card>
    </form>
  );
}
