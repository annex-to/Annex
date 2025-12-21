import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Card, Input, Label, Select, Skeleton } from "../../../components/ui";
import { trpc } from "../../../trpc";

export default function CardigannIndexerForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const indexerId = searchParams.get("indexerId");

  // First, load existing indexer if editing
  const existingIndexer = trpc.cardigann.getIndexer.useQuery(
    { id: indexerId || "" },
    { enabled: !!indexerId }
  );

  // Get definitionId from URL (create mode) or from existing indexer (edit mode)
  const definitionId = searchParams.get("definitionId") || existingIndexer.data?.definitionId || "";

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

  // Separate state for category input strings to allow typing
  const [movieCategoriesInput, setMovieCategoriesInput] = useState("");
  const [tvCategoriesInput, setTvCategoriesInput] = useState("");

  const definition = trpc.cardigann.getDefinition.useQuery(
    { id: definitionId },
    { enabled: !!definitionId }
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

  // Sync category inputs when formData changes (from badge clicks)
  useEffect(() => {
    setMovieCategoriesInput(formData.categoriesMovies.join(", "));
  }, [formData.categoriesMovies]);

  useEffect(() => {
    setTvCategoriesInput(formData.categoriesTv.join(", "));
  }, [formData.categoriesTv]);

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

  const toggleMovieCategory = (categoryId: number) => {
    setFormData((prev) => {
      const categories = prev.categoriesMovies.includes(categoryId)
        ? prev.categoriesMovies.filter((id) => id !== categoryId)
        : [...prev.categoriesMovies, categoryId].sort((a, b) => a - b);
      return { ...prev, categoriesMovies: categories };
    });
  };

  const toggleTvCategory = (categoryId: number) => {
    setFormData((prev) => {
      const categories = prev.categoriesTv.includes(categoryId)
        ? prev.categoriesTv.filter((id) => id !== categoryId)
        : [...prev.categoriesTv, categoryId].sort((a, b) => a - b);
      return { ...prev, categoriesTv: categories };
    });
  };

  const handleMovieCategoriesBlur = () => {
    const categories = movieCategoriesInput
      .split(",")
      .map((c) => parseInt(c.trim(), 10))
      .filter((c) => !Number.isNaN(c))
      .sort((a, b) => a - b);
    setFormData((prev) => ({ ...prev, categoriesMovies: categories }));
  };

  const handleTvCategoriesBlur = () => {
    const categories = tvCategoriesInput
      .split(",")
      .map((c) => parseInt(c.trim(), 10))
      .filter((c) => !Number.isNaN(c))
      .sort((a, b) => a - b);
    setFormData((prev) => ({ ...prev, categoriesTv: categories }));
  };

  // Only check loading state for enabled queries
  const isLoading =
    (definition.isLoading && !!definitionId) || (existingIndexer.isLoading && !!indexerId);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton count={1} className="h-8 w-64" />
        <Skeleton count={5} className="h-32" />
      </div>
    );
  }

  if (definition.isError) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold text-red-400">Error Loading Definition</h2>
        <Card className="p-4 bg-red-500/10 border-red-500/30">
          <p className="text-sm text-red-400">{definition.error?.message || "Unknown error"}</p>
        </Card>
        <Button onClick={() => navigate("/settings/indexers/cardigann")}>
          Back to Definitions
        </Button>
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

          {definition.data.definition.settings.map((setting) => {
            // Info type - just display text
            if (setting.type === "info") {
              return (
                <div key={setting.name} className="p-3 bg-white/5 rounded border border-white/10">
                  <p className="text-sm font-medium text-white/90 mb-1">{setting.label}</p>
                  {setting.default && (
                    <p className="text-sm text-white/60">{setting.default.toString()}</p>
                  )}
                </div>
              );
            }

            // Checkbox type
            if (setting.type === "checkbox") {
              return (
                <div key={setting.name} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={setting.name}
                    checked={formData.settings[setting.name] === "true"}
                    onChange={(e) => handleSettingChange(setting.name, e.target.checked.toString())}
                  />
                  <Label htmlFor={setting.name}>{setting.label}</Label>
                </div>
              );
            }

            // Select type
            if (setting.type === "select" && setting.options) {
              return (
                <div key={setting.name}>
                  <Label htmlFor={setting.name}>{setting.label}</Label>
                  <Select
                    id={setting.name}
                    value={formData.settings[setting.name] || ""}
                    onChange={(e) => handleSettingChange(setting.name, e.target.value)}
                  >
                    <option value="">Select...</option>
                    {Object.entries(setting.options).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            }

            // Text and password types
            return (
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
            );
          })}
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
              value={movieCategoriesInput}
              onChange={(e) => setMovieCategoriesInput(e.target.value)}
              onBlur={handleMovieCategoriesBlur}
              placeholder="8, 9, 11"
            />
            <p className="text-xs text-white/40 mt-1">
              Click categories below to add/remove, or enter IDs manually above
            </p>
            {definition.data.definition.caps?.categorymappings && (
              <div className="mt-2 flex flex-wrap gap-2">
                {definition.data.definition.caps.categorymappings
                  .filter((cat) => cat.cat.startsWith("Movies"))
                  .map((cat) => {
                    const categoryId = parseInt(cat.id, 10);
                    const isSelected = formData.categoriesMovies.includes(categoryId);
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => toggleMovieCategory(categoryId)}
                        className={`
                          px-2 py-1 text-xs rounded border transition-all
                          ${
                            isSelected
                              ? "bg-annex-500/20 border-annex-500/50 text-annex-400"
                              : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
                          }
                        `}
                      >
                        {cat.desc}
                      </button>
                    );
                  })}
              </div>
            )}
          </div>
        )}

        {definition.data.definition.caps?.modes?.["tv-search"] && (
          <div>
            <Label htmlFor="categoriesTv">TV Categories</Label>
            <Input
              id="categoriesTv"
              value={tvCategoriesInput}
              onChange={(e) => setTvCategoriesInput(e.target.value)}
              onBlur={handleTvCategoriesBlur}
              placeholder="26, 32, 27"
            />
            <p className="text-xs text-white/40 mt-1">
              Click categories below to add/remove, or enter IDs manually above
            </p>
            {definition.data.definition.caps?.categorymappings && (
              <div className="mt-2 flex flex-wrap gap-2">
                {definition.data.definition.caps.categorymappings
                  .filter((cat) => cat.cat.startsWith("TV"))
                  .map((cat) => {
                    const categoryId = parseInt(cat.id, 10);
                    const isSelected = formData.categoriesTv.includes(categoryId);
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => toggleTvCategory(categoryId)}
                        className={`
                          px-2 py-1 text-xs rounded border transition-all
                          ${
                            isSelected
                              ? "bg-annex-500/20 border-annex-500/50 text-annex-400"
                              : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
                          }
                        `}
                      >
                        {cat.desc}
                      </button>
                    );
                  })}
              </div>
            )}
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
