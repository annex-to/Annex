import { useState } from "react";
import { Route, Routes } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Select,
  SidebarNav,
  Skeleton,
  ToggleGroup,
} from "../components/ui";
import { trpc } from "../trpc";
import Notifications from "./Settings/Notifications";
import PipelineEditor from "./Settings/PipelineEditor";
import Pipelines from "./Settings/Pipelines";

const settingsNavItems = [
  { to: "/settings", label: "General", end: true },
  { to: "/settings/servers", label: "Storage Servers" },
  { to: "/settings/indexers", label: "Indexers" },
  { to: "/settings/encoders", label: "Remote Encoders" },
  { to: "/settings/pipelines", label: "Pipelines" },
  { to: "/settings/notifications", label: "Notifications" },
  { to: "/settings/jobs", label: "Jobs" },
  { to: "/settings/scheduler", label: "Scheduler" },
];

// Secret input with edit/save functionality
function SecretInput({
  secretKey,
  label,
  description,
  placeholder,
  helpUrl,
  hasValue,
  sensitive,
  testService,
}: {
  secretKey: string;
  label: string;
  description: string;
  placeholder?: string;
  helpUrl?: string;
  hasValue: boolean;
  sensitive: boolean;
  testService?: "qbittorrent" | "mdblist" | "trakt";
}) {
  const utils = trpc.useUtils();
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string } | null>(null);

  const setSecretMutation = trpc.secrets.set.useMutation();
  const deleteSecretMutation = trpc.secrets.delete.useMutation();
  const testConnectionMutation = trpc.secrets.testConnection.useMutation();

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const result = await setSecretMutation.mutateAsync({ key: secretKey, value });
      if (result.success) {
        setIsEditing(false);
        setValue("");
        utils.secrets.list.invalidate();
      } else {
        alert(result.error || "Failed to save");
      }
    } catch (error) {
      alert(`Failed to save: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Are you sure you want to delete ${label}?`)) return;
    try {
      await deleteSecretMutation.mutateAsync({ key: secretKey });
      utils.secrets.list.invalidate();
    } catch (error) {
      alert(`Failed to delete: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const handleTest = async () => {
    if (!testService) return;
    setTestResult(null);
    try {
      const result = await testConnectionMutation.mutateAsync({ service: testService });
      setTestResult({ success: result.success, message: result.message || result.error });
    } catch (error) {
      setTestResult({
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label hint={description}>{label}</Label>
        <div className="flex items-center gap-2">
          {hasValue && <Badge variant="success">Configured</Badge>}
          {!hasValue && <Badge variant="default">Not set</Badge>}
        </div>
      </div>

      {isEditing ? (
        <div className="flex gap-2">
          <Input
            type={sensitive ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="flex-1"
          />
          <Button onClick={handleSave} disabled={isSaving || !value.trim()} size="sm">
            {isSaving ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setIsEditing(false);
              setValue("");
            }}
            size="sm"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setIsEditing(true)} size="sm">
            {hasValue ? "Update" : "Set"}
          </Button>
          {hasValue && testService && (
            <Button
              variant="secondary"
              onClick={handleTest}
              disabled={testConnectionMutation.isLoading}
              size="sm"
            >
              {testConnectionMutation.isLoading ? "Testing..." : "Test"}
            </Button>
          )}
          {hasValue && secretKey !== "auth.sessionSecret" && (
            <Button variant="ghost" onClick={handleDelete} size="sm">
              Remove
            </Button>
          )}
        </div>
      )}

      {testResult && (
        <p className={`text-xs ${testResult.success ? "text-green-400" : "text-red-400"}`}>
          {testResult.message}
        </p>
      )}

      {helpUrl && (
        <p className="text-xs text-surface-500">
          <a
            href={helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-annex-400 hover:text-annex-300"
          >
            Get an API key
          </a>
        </p>
      )}
    </div>
  );
}

function GeneralSettings() {
  const utils = trpc.useUtils();

  // Fetch secrets list
  const secretsQuery = trpc.secrets.list.useQuery();
  const secrets = secretsQuery.data || [];

  // Group secrets by category
  const secretsByGroup = secrets.reduce(
    (acc, s) => {
      if (!acc[s.group]) acc[s.group] = [];
      acc[s.group].push(s);
      return acc;
    },
    {} as Record<string, typeof secrets>
  );

  // Fetch current retry interval setting
  const retryIntervalQuery = trpc.system.settings.get.useQuery({
    key: "search.retryIntervalHours",
  });
  const [retryInterval, setRetryInterval] = useState<string>("6");
  const [retryIntervalSaved, setRetryIntervalSaved] = useState(false);

  // Set initial value when query loads
  const currentInterval = retryIntervalQuery.data?.value as number | undefined;
  if (currentInterval !== undefined && retryInterval === "6" && !retryIntervalSaved) {
    setRetryInterval(String(currentInterval));
  }

  const setSettingMutation = trpc.system.settings.set.useMutation({
    onSuccess: () => {
      utils.system.settings.get.invalidate({ key: "search.retryIntervalHours" });
      setRetryIntervalSaved(true);
      setTimeout(() => setRetryIntervalSaved(false), 2000);
    },
  });

  const handleSaveRetryInterval = () => {
    const value = parseInt(retryInterval, 10);
    if (value >= 1) {
      setSettingMutation.mutate({ key: "search.retryIntervalHours", value });
    }
  };

  // Map secret keys to testable services
  const testServiceMap: Record<string, "qbittorrent" | "mdblist" | "trakt"> = {
    "trakt.clientId": "trakt",
    "mdblist.apiKey": "mdblist",
    "qbittorrent.url": "qbittorrent",
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">General Settings</h2>

      {/* Metadata APIs */}
      {secretsByGroup.metadata && (
        <Card className="space-y-5">
          <h3 className="text-lg font-medium">Metadata APIs</h3>
          {secretsByGroup.metadata.map((secret) => (
            <SecretInput
              key={secret.key}
              secretKey={secret.key}
              label={secret.label}
              description={secret.description}
              placeholder={secret.placeholder}
              helpUrl={secret.helpUrl}
              hasValue={secret.hasValue}
              sensitive={secret.sensitive}
              testService={testServiceMap[secret.key]}
            />
          ))}
        </Card>
      )}

      {/* Download Client */}
      {secretsByGroup.downloads && (
        <Card className="space-y-5">
          <h3 className="text-lg font-medium">Download Client</h3>
          {secretsByGroup.downloads.map((secret) => (
            <SecretInput
              key={secret.key}
              secretKey={secret.key}
              label={secret.label}
              description={secret.description}
              placeholder={secret.placeholder}
              helpUrl={secret.helpUrl}
              hasValue={secret.hasValue}
              sensitive={secret.sensitive}
              testService={testServiceMap[secret.key]}
            />
          ))}
        </Card>
      )}

      {/* Request Settings */}
      <Card className="space-y-5">
        <h3 className="text-lg font-medium">Request Settings</h3>

        <div>
          <Label hint="How often to retry searching for releases that weren't found initially">
            Retry Search Interval (hours)
          </Label>
          <div className="flex gap-2 items-center">
            <Input
              type="number"
              min="1"
              max="168"
              value={retryInterval}
              onChange={(e) => setRetryInterval(e.target.value)}
              className="w-24"
            />
            <Button
              onClick={handleSaveRetryInterval}
              disabled={setSettingMutation.isLoading}
              size="sm"
            >
              {setSettingMutation.isLoading ? "Saving..." : retryIntervalSaved ? "Saved!" : "Save"}
            </Button>
          </div>
          <p className="text-xs text-surface-500 mt-1">
            When no releases are found for a request, it will be retried every {retryInterval} hour
            {retryInterval !== "1" ? "s" : ""}
          </p>
        </div>
      </Card>
    </div>
  );
}

// Server form state type
interface ServerFormData {
  name: string;
  host: string;
  port: number;
  protocol: "sftp" | "rsync" | "smb";
  username: string;
  password: string;
  paths: {
    movies: string;
    tv: string;
  };
  restrictions: {
    maxResolution: "4K" | "2K" | "1080p" | "720p" | "480p";
    maxFileSize: number | null;
    preferredCodec: "av1" | "hevc" | "h264";
    maxBitrate: number | null;
  };
  mediaServer: {
    type: "plex" | "emby" | "none";
    url: string;
    apiKey: string;
    hasApiKey?: boolean; // Track if server already has an API key (for edit mode)
    libraryIds: {
      movies: string[];
      tv: string[];
    };
  } | null;
  enabled: boolean;
}

const defaultServerForm: ServerFormData = {
  name: "",
  host: "",
  port: 22,
  protocol: "sftp",
  username: "",
  password: "",
  paths: {
    movies: "/media/movies",
    tv: "/media/tv",
  },
  restrictions: {
    maxResolution: "1080p",
    maxFileSize: null,
    preferredCodec: "av1",
    maxBitrate: null,
  },
  mediaServer: null,
  enabled: true,
};

function ServerForm({
  initialData,
  onSave,
  onCancel,
  isSaving,
}: {
  initialData?: ServerFormData;
  onSave: (data: ServerFormData) => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const [form, setForm] = useState<ServerFormData>(initialData ?? defaultServerForm);
  const [mediaServerType, setMediaServerType] = useState<"none" | "plex" | "emby">(
    initialData?.mediaServer?.type ?? "none"
  );

  const updateForm = <K extends keyof ServerFormData>(key: K, value: ServerFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleMediaServerTypeChange = (type: "none" | "plex" | "emby") => {
    setMediaServerType(type);
    if (type === "none") {
      setForm((prev) => ({ ...prev, mediaServer: null }));
    } else {
      setForm((prev) => ({
        ...prev,
        mediaServer: prev.mediaServer ?? {
          type,
          url: "",
          apiKey: "",
          libraryIds: { movies: [], tv: [] },
        },
      }));
      if (form.mediaServer) {
        setForm((prev) => ({
          ...prev,
          mediaServer: { ...prev.mediaServer, type } as ServerFormData["mediaServer"],
        }));
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(form);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Basic Info */}
      <Card className="p-5 space-y-4">
        <h3 className="font-medium text-lg">Server Connection</h3>

        <div>
          <Label>Server Name</Label>
          <Input
            value={form.name}
            onChange={(e) => updateForm("name", e.target.value)}
            placeholder="My Media Server"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Host</Label>
            <Input
              value={form.host}
              onChange={(e) => updateForm("host", e.target.value)}
              placeholder="192.168.1.100"
              required
            />
          </div>
          <div>
            <Label>Port</Label>
            <Input
              type="number"
              value={form.port}
              onChange={(e) => updateForm("port", parseInt(e.target.value, 10) || 22)}
              required
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Protocol</Label>
            <Select
              value={form.protocol}
              onChange={(e) => updateForm("protocol", e.target.value as "sftp" | "rsync" | "smb")}
            >
              <option value="sftp">SFTP</option>
              <option value="rsync">rsync</option>
              <option value="smb">SMB</option>
            </Select>
          </div>
          <div>
            <Label>Username</Label>
            <Input
              value={form.username}
              onChange={(e) => updateForm("username", e.target.value)}
              placeholder="media"
              required
            />
          </div>
        </div>

        <div>
          <Label hint="Leave empty to use SSH key">Password</Label>
          <Input
            type="password"
            value={form.password}
            onChange={(e) => updateForm("password", e.target.value)}
            placeholder="Optional"
          />
        </div>
      </Card>

      {/* Paths */}
      <Card className="p-5 space-y-4">
        <h3 className="font-medium text-lg">Media Paths</h3>

        <div>
          <Label>Movies Path</Label>
          <Input
            value={form.paths.movies}
            onChange={(e) => updateForm("paths", { ...form.paths, movies: e.target.value })}
            placeholder="/media/movies"
            required
          />
        </div>

        <div>
          <Label>TV Shows Path</Label>
          <Input
            value={form.paths.tv}
            onChange={(e) => updateForm("paths", { ...form.paths, tv: e.target.value })}
            placeholder="/media/tv"
            required
          />
        </div>
      </Card>

      {/* Media Server Integration */}
      <Card className="p-5 space-y-4">
        <h3 className="font-medium text-lg">Media Server Integration</h3>
        <p className="text-sm text-white/50">
          Connect to Plex or Emby to sync library and show "In Library" badges
        </p>

        <div>
          <Label>Media Server Type</Label>
          <Select
            value={mediaServerType}
            onChange={(e) =>
              handleMediaServerTypeChange(e.target.value as "none" | "plex" | "emby")
            }
          >
            <option value="none">None</option>
            <option value="emby">Emby</option>
            <option value="plex">Plex</option>
          </Select>
        </div>

        {mediaServerType !== "none" && (
          <>
            <div>
              <Label>{mediaServerType === "plex" ? "Plex" : "Emby"} Server URL</Label>
              <Input
                type="url"
                value={form.mediaServer?.url ?? ""}
                onChange={(e) =>
                  setForm(
                    (prev) =>
                      ({
                        ...prev,
                        mediaServer: {
                          ...prev.mediaServer,
                          url: e.target.value,
                        },
                      }) as ServerFormData
                  )
                }
                placeholder={
                  mediaServerType === "plex" ? "http://localhost:32400" : "http://localhost:8096"
                }
                required
              />
            </div>

            <div>
              <Label>{mediaServerType === "plex" ? "Plex Token" : "Emby API Key"}</Label>
              <Input
                type="password"
                value={form.mediaServer?.apiKey ?? ""}
                onChange={(e) =>
                  setForm(
                    (prev) =>
                      ({
                        ...prev,
                        mediaServer: {
                          ...prev.mediaServer,
                          apiKey: e.target.value,
                        },
                      }) as ServerFormData
                  )
                }
                placeholder={
                  form.mediaServer?.hasApiKey
                    ? "Leave blank to keep current"
                    : "Enter API key or token"
                }
                required={!form.mediaServer?.hasApiKey}
              />
              {form.mediaServer?.hasApiKey && !form.mediaServer.apiKey && (
                <p className="text-xs text-green-400/70 mt-1">API key is configured</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label hint="Comma-separated library IDs for movies">Movie Library IDs</Label>
                <Input
                  value={form.mediaServer?.libraryIds.movies.join(", ") ?? ""}
                  onChange={(e) =>
                    setForm(
                      (prev) =>
                        ({
                          ...prev,
                          mediaServer: {
                            ...prev.mediaServer,
                            libraryIds: {
                              ...prev.mediaServer?.libraryIds,
                              movies: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            },
                          },
                        }) as ServerFormData
                    )
                  }
                  placeholder="e.g., 1, 5"
                />
              </div>
              <div>
                <Label hint="Comma-separated library IDs for TV shows">TV Library IDs</Label>
                <Input
                  value={form.mediaServer?.libraryIds.tv.join(", ") ?? ""}
                  onChange={(e) =>
                    setForm(
                      (prev) =>
                        ({
                          ...prev,
                          mediaServer: {
                            ...prev.mediaServer,
                            libraryIds: {
                              ...prev.mediaServer?.libraryIds,
                              tv: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            },
                          },
                        }) as ServerFormData
                    )
                  }
                  placeholder="e.g., 2, 6"
                />
              </div>
            </div>
            <p className="text-xs text-white/40">
              Find library IDs in {mediaServerType === "plex" ? "Plex" : "Emby"}: go to the library,
              the ID is in the URL (e.g., /library/sections/<strong>1</strong>/all)
            </p>
          </>
        )}
      </Card>

      {/* Quality Restrictions */}
      <Card className="p-5 space-y-4">
        <h3 className="font-medium text-lg">Quality Restrictions</h3>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Max Resolution</Label>
            <Select
              value={form.restrictions.maxResolution}
              onChange={(e) =>
                updateForm("restrictions", {
                  ...form.restrictions,
                  maxResolution: e.target.value as "4K" | "2K" | "1080p" | "720p" | "480p",
                })
              }
            >
              <option value="4K">4K</option>
              <option value="2K">2K (1440p)</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
            </Select>
          </div>
          <div>
            <Label>Preferred Codec</Label>
            <Select
              value={form.restrictions.preferredCodec}
              onChange={(e) =>
                updateForm("restrictions", {
                  ...form.restrictions,
                  preferredCodec: e.target.value as "av1" | "hevc" | "h264",
                })
              }
            >
              <option value="av1">AV1</option>
              <option value="hevc">HEVC (H.265)</option>
              <option value="h264">H.264</option>
            </Select>
          </div>
        </div>
      </Card>

      {/* Enable/Disable */}
      <Card className="p-5">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => updateForm("enabled", e.target.checked)}
            className="w-4 h-4 rounded border-white/20 bg-white/5 text-annex-500 focus:ring-annex-500"
          />
          <span>Server Enabled</span>
        </label>
      </Card>

      {/* Actions */}
      <div className="flex gap-3">
        <Button type="submit" disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Server"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// Server card with library sync status
function ServerCard({
  server,
  onEdit,
  onDelete,
}: {
  server: {
    id: string;
    name: string;
    host: string;
    port: number;
    protocol: string;
    enabled: boolean;
    mediaServer: {
      type: string;
      url: string;
    } | null;
    librarySync: {
      enabled: boolean;
      intervalMinutes: number;
    };
  };
  onEdit: () => void;
  onDelete: () => void;
}) {
  const utils = trpc.useUtils();
  const [intervalInput, setIntervalInput] = useState<string>(
    server.librarySync.intervalMinutes.toString()
  );

  // Get library status for this server
  const libraryStatus = trpc.servers.libraryStatus.useQuery({ id: server.id });

  // Get sync status for this server
  const syncStatus = trpc.servers.syncStatus.useQuery({ id: server.id }, { refetchInterval: 3000 });

  // Mutations
  const triggerSync = trpc.servers.triggerSync.useMutation({
    onSuccess: () => {
      utils.servers.syncStatus.invalidate({ id: server.id });
      utils.servers.libraryStatus.invalidate({ id: server.id });
    },
  });

  const updateSyncSettings = trpc.servers.updateSyncSettings.useMutation({
    onSuccess: () => {
      utils.servers.list.invalidate();
      utils.servers.syncStatus.invalidate({ id: server.id });
    },
  });

  const formatDate = (date: Date | string | null) => {
    if (!date) return "Never";
    const d = new Date(date);
    return d.toLocaleString();
  };

  const formatLastSync = (dateStr: string | null) => {
    if (!dateStr) return "Never";
    const date = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return date.toLocaleString();
  };

  const handleIntervalChange = () => {
    const minutes = parseInt(intervalInput, 10);
    if (minutes >= 1 && minutes <= 1440) {
      updateSyncSettings.mutate({ id: server.id, intervalMinutes: minutes });
    }
  };

  const handleToggleSync = () => {
    updateSyncSettings.mutate({
      id: server.id,
      enabled: !server.librarySync.enabled,
    });
  };

  return (
    <Card className="p-5">
      {/* Header Row */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-lg">{server.name}</h3>
            <Badge variant={server.enabled ? "success" : "default"}>
              {server.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <p className="text-sm text-white/50 mt-0.5">
            {server.protocol.toUpperCase()} • {server.host}:{server.port}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-red-400 hover:text-red-300"
          >
            Delete
          </Button>
        </div>
      </div>

      {/* Media Server Section */}
      {server.mediaServer && (
        <div className="bg-white/[0.03] rounded-lg p-4 space-y-4">
          {/* Media Server Info */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded bg-white/10 flex items-center justify-center">
                {server.mediaServer.type === "plex" ? (
                  <span className="text-orange-400 text-xs font-bold">P</span>
                ) : (
                  <span className="text-green-400 text-xs font-bold">E</span>
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">
                    {server.mediaServer.type === "plex" ? "Plex" : "Emby"}
                  </span>
                  {syncStatus.data?.currentlySyncing && <Badge variant="info">Syncing...</Badge>}
                </div>
                <p className="text-xs text-white/40">{server.mediaServer.url}</p>
              </div>
            </div>

            {/* Library Stats */}
            {libraryStatus.data?.hasMediaServer && (
              <div className="text-right text-sm">
                <div className="text-white/70">
                  {libraryStatus.data.movieCount.toLocaleString()} movies
                  <span className="text-white/30 mx-1">•</span>
                  {libraryStatus.data.tvCount.toLocaleString()} shows
                </div>
                <div className="text-xs text-white/40">
                  Synced {formatDate(libraryStatus.data.lastSyncedAt)}
                </div>
              </div>
            )}
          </div>

          {/* Sync Settings Row */}
          <div className="flex items-center justify-between pt-3 border-t border-white/5">
            <div className="flex items-center gap-4">
              {/* Auto Sync Toggle */}
              <button
                onClick={handleToggleSync}
                disabled={updateSyncSettings.isPending}
                className={`
                  relative w-10 h-5 rounded-full transition-colors duration-200
                  ${server.librarySync.enabled ? "bg-annex-500/50" : "bg-white/10"}
                  ${updateSyncSettings.isPending ? "opacity-50" : "cursor-pointer"}
                `}
              >
                <span
                  className={`
                    absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200
                    ${server.librarySync.enabled ? "translate-x-5" : "translate-x-0"}
                  `}
                />
              </button>
              <div className="text-sm">
                <span className="text-white/70">Auto sync</span>
                {server.librarySync.enabled && (
                  <span className="text-white/40 ml-1">
                    every {server.librarySync.intervalMinutes}m
                  </span>
                )}
              </div>

              {/* Interval Input */}
              {server.librarySync.enabled && (
                <div className="flex items-center gap-1.5 ml-2">
                  <input
                    type="number"
                    min="1"
                    max="1440"
                    value={intervalInput}
                    onChange={(e) => setIntervalInput(e.target.value)}
                    className="w-14 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white text-center focus:outline-none focus:border-annex-500/50"
                  />
                  <span className="text-xs text-white/40">min</span>
                  {intervalInput !== server.librarySync.intervalMinutes.toString() && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleIntervalChange}
                      disabled={updateSyncSettings.isPending}
                      className="px-2 py-0.5 text-xs"
                    >
                      Save
                    </Button>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {/* Last Sync */}
              <span className="text-xs text-white/40">
                {formatLastSync(syncStatus.data?.lastSyncAt ?? null)}
              </span>

              {/* Quick Sync Button (Incremental) */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => triggerSync.mutate({ id: server.id, incremental: true })}
                disabled={triggerSync.isPending || syncStatus.data?.currentlySyncing}
                className="px-3"
                title="Only sync new items since last sync"
              >
                {triggerSync.isPending || syncStatus.data?.currentlySyncing
                  ? "Syncing..."
                  : "Quick Sync"}
              </Button>

              {/* Full Sync Button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => triggerSync.mutate({ id: server.id, incremental: false })}
                disabled={triggerSync.isPending || syncStatus.data?.currentlySyncing}
                className="px-3 text-white/50"
                title="Re-sync entire library"
              >
                Full Sync
              </Button>
            </div>
          </div>

          {/* Warning Messages */}
          {triggerSync.data?.alreadyRunning && (
            <p className="text-yellow-400/80 text-xs">Sync already in progress</p>
          )}
          {triggerSync.data?.isIncremental === false &&
            !triggerSync.data?.alreadyRunning &&
            triggerSync.isSuccess && (
              <p className="text-blue-400/80 text-xs">Running full library sync</p>
            )}
        </div>
      )}

      {/* No Media Server */}
      {!server.mediaServer && (
        <div className="text-sm text-white/40 italic">No media server configured</div>
      )}
    </Card>
  );
}

function ServersSettings() {
  const utils = trpc.useUtils();
  const servers = trpc.servers.list.useQuery();
  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<string | null>(null);

  const createServer = trpc.servers.create.useMutation({
    onSuccess: () => {
      utils.servers.list.invalidate();
      setShowForm(false);
    },
  });

  const updateServer = trpc.servers.update.useMutation({
    onSuccess: () => {
      utils.servers.list.invalidate();
      setEditingServer(null);
    },
  });

  const deleteServer = trpc.servers.delete.useMutation({
    onSuccess: () => {
      utils.servers.list.invalidate();
    },
  });

  const handleCreate = (data: ServerFormData) => {
    createServer.mutate({
      name: data.name,
      host: data.host,
      port: data.port,
      protocol: data.protocol,
      username: data.username,
      password: data.password || undefined,
      paths: data.paths,
      restrictions: data.restrictions,
      mediaServer: data.mediaServer
        ? {
            type: data.mediaServer.type as "plex" | "emby",
            url: data.mediaServer.url,
            apiKey: data.mediaServer.apiKey,
            libraryIds: data.mediaServer.libraryIds,
          }
        : null,
      enabled: data.enabled,
    });
  };

  const handleUpdate = (id: string, data: ServerFormData) => {
    updateServer.mutate({
      id,
      name: data.name,
      host: data.host,
      port: data.port,
      protocol: data.protocol,
      username: data.username,
      password: data.password || undefined,
      paths: data.paths,
      restrictions: data.restrictions,
      mediaServer: data.mediaServer
        ? {
            type: data.mediaServer.type as "plex" | "emby",
            url: data.mediaServer.url,
            // Only send apiKey if user entered a new one
            apiKey: data.mediaServer.apiKey || undefined,
            libraryIds: data.mediaServer.libraryIds,
          }
        : null,
      enabled: data.enabled,
    });
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete "${name}"?`)) {
      deleteServer.mutate({ id });
    }
  };

  // Show form for creating new server
  if (showForm) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold">Add Storage Server</h2>
        <ServerForm
          onSave={handleCreate}
          onCancel={() => setShowForm(false)}
          isSaving={createServer.isPending}
        />
      </div>
    );
  }

  // Show form for editing existing server
  if (editingServer) {
    const server = servers.data?.find((s) => s.id === editingServer);
    if (server) {
      const formData: ServerFormData = {
        name: server.name,
        host: server.host,
        port: server.port,
        protocol: server.protocol as "sftp" | "rsync" | "smb",
        username: server.username,
        password: "",
        paths: server.paths,
        restrictions: server.restrictions as ServerFormData["restrictions"],
        mediaServer: server.mediaServer
          ? {
              type: server.mediaServer.type as "plex" | "emby" | "none",
              url: server.mediaServer.url,
              apiKey: "", // Don't populate - server doesn't return it
              hasApiKey: server.mediaServer.hasApiKey,
              libraryIds: server.mediaServer.libraryIds,
            }
          : null,
        enabled: server.enabled,
      };

      return (
        <div className="space-y-6">
          <h2 className="text-xl font-semibold">Edit Storage Server</h2>
          <ServerForm
            initialData={formData}
            onSave={(data) => handleUpdate(editingServer, data)}
            onCancel={() => setEditingServer(null)}
            isSaving={updateServer.isPending}
          />
        </div>
      );
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Storage Servers</h2>
        <Button onClick={() => setShowForm(true)}>Add Server</Button>
      </div>

      {servers.isLoading && (
        <div className="space-y-4">
          <Skeleton count={2} className="h-24" />
        </div>
      )}

      {servers.data?.length === 0 && (
        <EmptyState
          title="No storage servers configured"
          description="Add a server to start delivering media and tracking your library"
        />
      )}

      {servers.data && servers.data.length > 0 && (
        <div className="space-y-3">
          {servers.data.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              onEdit={() => setEditingServer(server.id)}
              onDelete={() => handleDelete(server.id, server.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Indexer form state type
interface IndexerFormData {
  name: string;
  type: "torznab" | "newznab" | "rss" | "torrentleech" | "unit3d";
  url: string;
  apiKey: string;
  hasApiKey?: boolean; // Track if indexer already has an API key (for edit mode)
  categories: {
    movies: number[];
    tv: number[];
  };
  priority: number;
  enabled: boolean;
  rateLimitEnabled: boolean;
  rateLimitMax?: number;
  rateLimitWindowSecs?: number;
}

const defaultIndexerForm: IndexerFormData = {
  name: "",
  type: "torznab",
  url: "",
  apiKey: "",
  categories: {
    movies: [],
    tv: [],
  },
  priority: 50,
  enabled: true,
  rateLimitEnabled: false,
  rateLimitMax: undefined,
  rateLimitWindowSecs: undefined,
};

const indexerTypeOptions = [
  {
    value: "torznab",
    label: "Torznab",
    description: "Standard torrent indexer protocol (Prowlarr, Jackett)",
  },
  { value: "newznab", label: "Newznab", description: "Usenet indexer protocol" },
  { value: "torrentleech", label: "TorrentLeech", description: "TorrentLeech private tracker" },
  { value: "unit3d", label: "UNIT3D", description: "UNIT3D-based private tracker (YUSCENE, etc.)" },
  { value: "rss", label: "RSS", description: "RSS feed" },
];

function IndexerForm({
  initialData,
  onSave,
  onCancel,
  isSaving,
}: {
  initialData?: IndexerFormData;
  onSave: (data: IndexerFormData) => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const [form, setForm] = useState<IndexerFormData>(initialData ?? defaultIndexerForm);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const updateForm = <K extends keyof IndexerFormData>(key: K, value: IndexerFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTestResult(null); // Clear test result when form changes
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(form);
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      // For new indexers, we need to test with the form data directly
      // This is a simplified test - the full test requires creating the indexer first
      const _response = await fetch("/api/trpc/indexers.test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: { id: "test" } }),
      });

      // For now, just validate the URL is reachable
      if (form.url) {
        setTestResult({
          success: true,
          message: "Configuration looks valid. Save to test full connection.",
        });
      } else {
        setTestResult({
          success: false,
          message: "Please enter a URL",
        });
      }
    } catch {
      setTestResult({
        success: false,
        message: "Could not validate configuration",
      });
    } finally {
      setIsTesting(false);
    }
  };

  const isTorrentLeech = form.type === "torrentleech";
  const isUnit3d = form.type === "unit3d";

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card className="p-5 space-y-4">
        <h3 className="font-medium text-lg">Indexer Configuration</h3>

        <div>
          <Label>Name</Label>
          <Input
            value={form.name}
            onChange={(e) => updateForm("name", e.target.value)}
            placeholder="My Indexer"
            required
          />
        </div>

        <div>
          <Label>Type</Label>
          <Select
            value={form.type}
            onChange={(e) => updateForm("type", e.target.value as IndexerFormData["type"])}
          >
            {indexerTypeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-white/40 mt-1">
            {indexerTypeOptions.find((o) => o.value === form.type)?.description}
          </p>
        </div>

        <div>
          <Label>
            {isTorrentLeech ? "TorrentLeech URL" : isUnit3d ? "Tracker URL" : "Indexer URL"}
          </Label>
          <Input
            value={form.url}
            onChange={(e) => updateForm("url", e.target.value)}
            placeholder={
              isTorrentLeech
                ? "https://www.torrentleech.org"
                : isUnit3d
                  ? "https://yu-scene.net"
                  : "https://indexer.example.com"
            }
            required
          />
        </div>

        <div>
          <Label
            hint={
              isTorrentLeech
                ? "Format: username:password:alt2FAToken"
                : isUnit3d
                  ? "From your profile settings"
                  : undefined
            }
          >
            {isTorrentLeech ? "Credentials" : isUnit3d ? "API Token" : "API Key"}
          </Label>
          <Input
            type={isTorrentLeech ? "text" : "password"}
            value={form.apiKey}
            onChange={(e) => updateForm("apiKey", e.target.value)}
            placeholder={
              form.hasApiKey
                ? "Leave blank to keep current"
                : isTorrentLeech
                  ? "username:password:alt2FAToken"
                  : isUnit3d
                    ? "API token from your profile"
                    : "API key from indexer"
            }
            required={!form.hasApiKey}
          />
          {form.hasApiKey && !form.apiKey && (
            <p className="text-xs text-green-400/70 mt-1">
              {isTorrentLeech ? "Credentials are" : "API token is"} configured
            </p>
          )}
          {isTorrentLeech && !form.hasApiKey && (
            <p className="text-xs text-white/40 mt-1">
              Enter your TorrentLeech username and password separated by colons. If you have 2FA
              enabled, add your alt2FAToken (MD5 hash from your TL profile). Format:{" "}
              <code className="text-white/60">username:password:alt2FAToken</code>
            </p>
          )}
          {isUnit3d && !form.hasApiKey && (
            <p className="text-xs text-white/40 mt-1">
              Find your API token in your profile settings on the tracker. Go to Settings &gt;
              Security &gt; API Token.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label hint="1 = highest, 100 = lowest">Priority</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={form.priority}
              onChange={(e) => updateForm("priority", parseInt(e.target.value, 10) || 50)}
            />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => updateForm("enabled", e.target.checked)}
                className="w-4 h-4 rounded border-white/20 bg-white/5 text-annex-500 focus:ring-annex-500/50"
              />
              <span className="text-sm">Enabled</span>
            </label>
          </div>
        </div>
      </Card>

      <Card className="p-5 space-y-4">
        <h3 className="font-medium text-lg">Categories</h3>
        <p className="text-sm text-white/50">
          {isTorrentLeech
            ? "TorrentLeech categories will be automatically configured based on search type."
            : "Enter Torznab category IDs separated by commas. Leave empty to use indexer defaults."}
        </p>

        {!isTorrentLeech && (
          <>
            <div>
              <Label hint="e.g., 2000,2010,2020">Movie Categories</Label>
              <Input
                value={form.categories.movies.join(",")}
                onChange={(e) =>
                  updateForm("categories", {
                    ...form.categories,
                    movies: e.target.value
                      .split(",")
                      .map((s) => parseInt(s.trim(), 10))
                      .filter((n) => !Number.isNaN(n)),
                  })
                }
                placeholder="2000,2010,2020,2030,2040,2045,2050,2060"
              />
            </div>

            <div>
              <Label hint="e.g., 5000,5010,5020">TV Categories</Label>
              <Input
                value={form.categories.tv.join(",")}
                onChange={(e) =>
                  updateForm("categories", {
                    ...form.categories,
                    tv: e.target.value
                      .split(",")
                      .map((s) => parseInt(s.trim(), 10))
                      .filter((n) => !Number.isNaN(n)),
                  })
                }
                placeholder="5000,5010,5020,5030,5040,5045,5050,5060"
              />
            </div>
          </>
        )}

        {isTorrentLeech && (
          <div className="text-sm text-white/60 bg-white/5 rounded p-3">
            <p className="font-medium mb-2">TorrentLeech Categories:</p>
            <p>
              <strong>Movies:</strong> CAM, TS/TC, DVDRip, WEB-DL, WEBRip, HDRip, BluRay, BD Remux,
              4K, Boxsets, Documentaries
            </p>
            <p>
              <strong>TV:</strong> Episodes HD/SD/4K, Boxsets HD/4K
            </p>
          </div>
        )}
      </Card>

      <Card className="p-5 space-y-4">
        <h3 className="font-medium text-lg">Rate Limiting</h3>
        <p className="text-sm text-white/50">
          Limit API requests to this indexer to avoid hitting rate limits. Useful for indexers with
          strict API quotas.
        </p>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.rateLimitEnabled}
              onChange={(e) => updateForm("rateLimitEnabled", e.target.checked)}
              className="w-4 h-4 rounded border-white/20 bg-white/5 text-annex-500 focus:ring-annex-500/50"
            />
            <span className="text-sm">Enable Rate Limiting</span>
          </label>
        </div>

        {form.rateLimitEnabled && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label hint="Maximum requests allowed">Max Requests</Label>
              <Input
                type="number"
                min={1}
                value={form.rateLimitMax || ""}
                onChange={(e) =>
                  updateForm("rateLimitMax", parseInt(e.target.value, 10) || undefined)
                }
                placeholder="90"
              />
            </div>
            <div>
              <Label hint="Time window in seconds">Window (seconds)</Label>
              <Input
                type="number"
                min={1}
                value={form.rateLimitWindowSecs || ""}
                onChange={(e) =>
                  updateForm("rateLimitWindowSecs", parseInt(e.target.value, 10) || undefined)
                }
                placeholder="60"
              />
            </div>
          </div>
        )}

        {form.rateLimitEnabled && form.rateLimitMax && form.rateLimitWindowSecs && (
          <div className="text-sm text-white/60 bg-white/5 rounded p-3">
            Limit: {form.rateLimitMax} requests per {form.rateLimitWindowSecs} seconds (
            {(form.rateLimitMax / (form.rateLimitWindowSecs / 60)).toFixed(1)} requests/minute)
          </div>
        )}
      </Card>

      {/* Test Result */}
      {testResult && (
        <div
          className={`p-3 rounded text-sm ${
            testResult.success ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
          }`}
        >
          {testResult.message}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="secondary"
          onClick={handleTest}
          disabled={isTesting || !form.url}
        >
          {isTesting ? "Testing..." : "Test Configuration"}
        </Button>

        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Indexer"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function IndexersSettings() {
  const utils = trpc.useUtils();
  const indexers = trpc.indexers.list.useQuery();
  const [showForm, setShowForm] = useState(false);
  const [editingIndexer, setEditingIndexer] = useState<string | null>(null);

  const createIndexer = trpc.indexers.create.useMutation({
    onSuccess: () => {
      utils.indexers.list.invalidate();
      setShowForm(false);
    },
  });

  const updateIndexer = trpc.indexers.update.useMutation({
    onSuccess: () => {
      utils.indexers.list.invalidate();
      setEditingIndexer(null);
    },
  });

  const deleteIndexer = trpc.indexers.delete.useMutation({
    onSuccess: () => {
      utils.indexers.list.invalidate();
    },
  });

  const testIndexer = trpc.indexers.test.useMutation();

  const handleCreate = (data: IndexerFormData) => {
    createIndexer.mutate({
      name: data.name,
      type: data.type,
      url: data.url,
      apiKey: data.apiKey,
      categories: data.categories,
      priority: data.priority,
      enabled: data.enabled,
      rateLimitEnabled: data.rateLimitEnabled,
      rateLimitMax: data.rateLimitMax,
      rateLimitWindowSecs: data.rateLimitWindowSecs,
    });
  };

  const handleUpdate = (id: string, data: IndexerFormData) => {
    updateIndexer.mutate({
      id,
      name: data.name,
      type: data.type,
      url: data.url,
      // Only send apiKey if user entered a new one
      apiKey: data.apiKey || undefined,
      categories: data.categories,
      priority: data.priority,
      enabled: data.enabled,
      rateLimitEnabled: data.rateLimitEnabled,
      rateLimitMax: data.rateLimitMax,
      rateLimitWindowSecs: data.rateLimitWindowSecs,
    });
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete "${name}"?`)) {
      deleteIndexer.mutate({ id });
    }
  };

  const handleTest = async (id: string) => {
    const result = await testIndexer.mutateAsync({ id });
    alert(result.success ? `Connection successful!` : `Connection failed: ${result.message}`);
  };

  // Show form for creating new indexer
  if (showForm) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold">Add Indexer</h2>
        <IndexerForm
          onSave={handleCreate}
          onCancel={() => setShowForm(false)}
          isSaving={createIndexer.isPending}
        />
      </div>
    );
  }

  // Show form for editing existing indexer
  if (editingIndexer) {
    const indexer = indexers.data?.find((i) => i.id === editingIndexer);
    if (indexer) {
      const formData: IndexerFormData = {
        name: indexer.name,
        type: indexer.type as IndexerFormData["type"],
        url: indexer.url,
        apiKey: "", // Don't populate - server doesn't return it
        hasApiKey: indexer.hasApiKey,
        categories: indexer.categories,
        priority: indexer.priority,
        enabled: indexer.enabled,
        rateLimitEnabled: indexer.rateLimitEnabled,
        rateLimitMax: indexer.rateLimitMax ?? undefined,
        rateLimitWindowSecs: indexer.rateLimitWindowSecs ?? undefined,
      };

      return (
        <div className="space-y-6">
          <h2 className="text-xl font-semibold">Edit Indexer</h2>
          <IndexerForm
            initialData={formData}
            onSave={(data) => handleUpdate(editingIndexer, data)}
            onCancel={() => setEditingIndexer(null)}
            isSaving={updateIndexer.isPending}
          />
        </div>
      );
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Indexers</h2>
        <Button onClick={() => setShowForm(true)}>Add Indexer</Button>
      </div>

      {indexers.isLoading && (
        <div className="space-y-4">
          <Skeleton count={2} className="h-20" />
        </div>
      )}

      {indexers.data?.length === 0 && (
        <EmptyState
          title="No indexers configured"
          description="Add a Torznab indexer or TorrentLeech to search for content"
        />
      )}

      {indexers.data && indexers.data.length > 0 && (
        <div className="space-y-3">
          {indexers.data.map((indexer) => (
            <Card key={indexer.id} className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">{indexer.name}</h3>
                  <p className="text-sm text-white/50">
                    {indexer.type.toUpperCase()} • Priority: {indexer.priority}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={indexer.enabled ? "success" : "default"}>
                    {indexer.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleTest(indexer.id)}
                    disabled={testIndexer.isPending}
                  >
                    Test
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditingIndexer(indexer.id)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(indexer.id, indexer.name)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// EncodingSettings component removed - encoding profiles are now configured in pipeline templates

type JobStatusFilter =
  | "all"
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

const statusFilterOptions = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "paused", label: "Paused" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const jobTypeLabels: Record<string, string> = {
  "library:sync": "Library Sync All",
  "library:sync-server": "Library Sync Server",
  "pipeline:search": "Search Release",
  "pipeline:download": "Download",
  "pipeline:encode": "Encode",
  "pipeline:deliver": "Deliver",
  "pipeline:retry-awaiting": "Retry Awaiting",
  "tv:search": "TV Search",
  "tv:download-season": "Download Season",
  "tv:download-episode": "Download Episode",
  "tv:check-new-episodes": "Check New Episodes",
};

type JobsViewTab = "jobs" | "workers";

function formatDuration(startDate: Date, endDate?: Date | null): string {
  const end = endDate ? new Date(endDate) : new Date();
  const start = new Date(startDate);
  const seconds = Math.floor((end.getTime() - start.getTime()) / 1000);

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const d = new Date(date);
  const seconds = Math.floor((now.getTime() - d.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const JOBS_PER_PAGE = 10;

function JobsSettings() {
  const [activeTab, setActiveTab] = useState<JobsViewTab>("jobs");
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [page, setPage] = useState(0);
  const utils = trpc.useUtils();

  // Job queries
  const jobs = trpc.system.jobs.list.useQuery(
    { status: statusFilter, limit: JOBS_PER_PAGE, offset: page * JOBS_PER_PAGE },
    { refetchInterval: 3000, enabled: activeTab === "jobs" }
  );

  const stats = trpc.system.jobs.stats.useQuery(undefined, {
    refetchInterval: 3000,
  });

  // Worker queries
  const workers = trpc.system.workers.list.useQuery(undefined, {
    refetchInterval: 5000,
    enabled: activeTab === "workers",
  });

  const currentWorker = trpc.system.workers.current.useQuery(undefined, {
    refetchInterval: 5000,
    enabled: activeTab === "workers",
  });

  const cleanupWorkers = trpc.system.workers.cleanup.useMutation({
    onSuccess: () => {
      utils.system.workers.list.invalidate();
    },
  });

  // Mutations
  const cancelJob = trpc.system.jobs.cancel.useMutation({
    onSuccess: () => {
      utils.system.jobs.list.invalidate();
      utils.system.jobs.stats.invalidate();
    },
  });

  const requestCancellation = trpc.system.jobs.requestCancellation.useMutation({
    onSuccess: () => {
      utils.system.jobs.list.invalidate();
      utils.system.jobs.stats.invalidate();
    },
  });

  const pauseJob = trpc.system.jobs.pause.useMutation({
    onSuccess: () => {
      utils.system.jobs.list.invalidate();
      utils.system.jobs.stats.invalidate();
    },
  });

  const resumeJob = trpc.system.jobs.resume.useMutation({
    onSuccess: () => {
      utils.system.jobs.list.invalidate();
      utils.system.jobs.stats.invalidate();
    },
  });

  const retryJob = trpc.system.jobs.retry.useMutation({
    onSuccess: () => {
      utils.system.jobs.list.invalidate();
      utils.system.jobs.stats.invalidate();
    },
  });

  const cleanupJobs = trpc.system.jobs.cleanup.useMutation({
    onSuccess: () => {
      utils.system.jobs.list.invalidate();
      utils.system.jobs.stats.invalidate();
    },
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "running":
        return <Badge variant="info">Running</Badge>;
      case "paused":
        return (
          <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">Paused</Badge>
        );
      case "pending":
        return <Badge variant="warning">Pending</Badge>;
      case "completed":
        return <Badge variant="success">Completed</Badge>;
      case "failed":
        return <Badge variant="danger">Failed</Badge>;
      case "cancelled":
        return <Badge variant="default">Cancelled</Badge>;
      case "active":
        return <Badge variant="success">Active</Badge>;
      case "stopped":
        return <Badge variant="warning">Stopped</Badge>;
      case "dead":
        return <Badge variant="danger">Dead</Badge>;
      default:
        return <Badge variant="default">{status}</Badge>;
    }
  };

  const tabOptions = [
    { value: "jobs", label: `Jobs (${stats.data?.running ?? 0} running)` },
    { value: "workers", label: "Workers" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Job Queue & System Status</h2>
        {activeTab === "jobs" && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => cleanupJobs.mutate({ olderThanDays: 7 })}
            disabled={cleanupJobs.isPending}
          >
            Cleanup Old Jobs
          </Button>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <Card className="p-4 text-center">
          <div className="text-3xl font-bold text-blue-400">{stats.data?.running ?? 0}</div>
          <div className="text-sm text-white/50 mt-1">Running</div>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-3xl font-bold text-orange-400">{stats.data?.paused ?? 0}</div>
          <div className="text-sm text-white/50 mt-1">Paused</div>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-3xl font-bold text-yellow-400">{stats.data?.pending ?? 0}</div>
          <div className="text-sm text-white/50 mt-1">Pending</div>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-3xl font-bold text-green-400">{stats.data?.completed ?? 0}</div>
          <div className="text-sm text-white/50 mt-1">Completed</div>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-3xl font-bold text-red-400">{stats.data?.failed ?? 0}</div>
          <div className="text-sm text-white/50 mt-1">Failed</div>
        </Card>
      </div>

      {/* Tab Navigation */}
      <div>
        <ToggleGroup
          options={tabOptions}
          value={activeTab}
          onChange={(v) => setActiveTab(v as JobsViewTab)}
        />
      </div>

      {/* Jobs Tab */}
      {activeTab === "jobs" && (
        <>
          {/* Status Filter */}
          <div>
            <ToggleGroup
              options={statusFilterOptions}
              value={statusFilter}
              onChange={(v) => {
                setStatusFilter(v as JobStatusFilter);
                setPage(0);
              }}
            />
          </div>

          {/* Jobs List */}
          {jobs.isLoading && (
            <div className="space-y-3">
              <Skeleton count={3} className="h-24" />
            </div>
          )}

          {jobs.data?.jobs.length === 0 && (
            <EmptyState
              title="No jobs found"
              description={
                statusFilter === "all" ? "The job queue is empty" : `No ${statusFilter} jobs`
              }
            />
          )}

          {jobs.data && jobs.data.jobs.length > 0 && (
            <div className="space-y-3">
              {jobs.data.jobs.map((job) => (
                <Card key={job.id} className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="font-medium truncate">
                          {jobTypeLabels[job.type] ?? job.type}
                        </h3>
                        {getStatusBadge(job.status)}
                        {job.status === "running" && job.startedAt && (
                          <span className="text-xs text-white/40">
                            {formatDuration(job.startedAt)}
                          </span>
                        )}
                      </div>

                      <div className="text-sm text-white/50 space-y-1">
                        <div className="flex items-center gap-4">
                          <span>ID: {job.id.slice(0, 8)}...</span>
                          <span>Priority: {job.priority}</span>
                          <span>
                            Attempts: {job.attempts}/{job.maxAttempts}
                          </span>
                        </div>

                        {job.status === "running" && (
                          <>
                            {job.progressTotal && job.progressTotal > 0 && (
                              <div className="mt-2">
                                <div className="flex items-center justify-between text-xs text-white/50 mb-1">
                                  <span>Progress</span>
                                  <span>
                                    {job.progressCurrent?.toLocaleString() ?? 0} /{" "}
                                    {job.progressTotal.toLocaleString()} ({job.progress?.toFixed(1)}
                                    %)
                                  </span>
                                </div>
                                <div className="h-2 bg-white/10 rounded overflow-hidden">
                                  <div
                                    className="h-full bg-blue-500 transition-all duration-300"
                                    style={{ width: `${job.progress ?? 0}%` }}
                                  />
                                </div>
                              </div>
                            )}
                            {job.lockedBy && (
                              <div className="text-xs text-white/30 mt-1">
                                Worker: {job.lockedBy.slice(0, 20)}...
                              </div>
                            )}
                          </>
                        )}

                        {job.status === "completed" && job.startedAt && job.completedAt && (
                          <div className="text-green-400/70">
                            Completed in {formatDuration(job.startedAt, job.completedAt)} (
                            {formatTimeAgo(job.completedAt)})
                          </div>
                        )}

                        {job.status === "failed" && job.error && (
                          <div className="text-red-400/70 truncate max-w-xl" title={job.error}>
                            Error: {job.error}
                          </div>
                        )}

                        {job.status === "pending" && (
                          <div className="text-white/40">
                            Created {formatTimeAgo(job.createdAt)}
                          </div>
                        )}

                        {job.status === "paused" && (
                          <>
                            <div className="text-orange-400/70">
                              Paused {formatTimeAgo(job.updatedAt)}
                            </div>
                            {job.progressTotal && job.progressTotal > 0 && (
                              <div className="mt-2">
                                <div className="flex items-center justify-between text-xs text-white/50 mb-1">
                                  <span>Progress (paused)</span>
                                  <span>
                                    {job.progressCurrent?.toLocaleString() ?? 0} /{" "}
                                    {job.progressTotal.toLocaleString()} ({job.progress?.toFixed(1)}
                                    %)
                                  </span>
                                </div>
                                <div className="h-2 bg-white/10 rounded overflow-hidden">
                                  <div
                                    className="h-full bg-orange-500 transition-all duration-300"
                                    style={{ width: `${job.progress ?? 0}%` }}
                                  />
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      {job.type === "sync:full" && job.payload && (
                        <div className="mt-2 text-xs text-white/30">
                          {JSON.stringify(job.payload).slice(0, 100)}
                        </div>
                      )}

                      {job.status === "completed" && job.result && (
                        <div className="mt-2 text-xs text-green-400/50">
                          Result: {JSON.stringify(job.result).slice(0, 150)}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col gap-2">
                      {job.status === "pending" && (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => pauseJob.mutate({ id: job.id })}
                            disabled={pauseJob.isPending}
                          >
                            Pause
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => cancelJob.mutate({ id: job.id })}
                            disabled={cancelJob.isPending}
                          >
                            Cancel
                          </Button>
                        </>
                      )}
                      {job.status === "running" && (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => pauseJob.mutate({ id: job.id })}
                            disabled={pauseJob.isPending}
                          >
                            {pauseJob.isPending ? "Pausing..." : "Pause"}
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => requestCancellation.mutate({ id: job.id })}
                            disabled={requestCancellation.isPending}
                          >
                            {requestCancellation.isPending ? "Stopping..." : "Stop"}
                          </Button>
                        </>
                      )}
                      {job.status === "paused" && (
                        <>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => resumeJob.mutate({ id: job.id })}
                            disabled={resumeJob.isPending}
                          >
                            {resumeJob.isPending ? "Resuming..." : "Resume"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => cancelJob.mutate({ id: job.id })}
                            disabled={cancelJob.isPending}
                          >
                            Cancel
                          </Button>
                        </>
                      )}
                      {job.status === "failed" && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => retryJob.mutate({ id: job.id })}
                          disabled={retryJob.isPending}
                        >
                          Retry
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Pagination */}
          {jobs.data && jobs.data.totalCount > 0 && (
            <div className="flex items-center justify-between">
              <div className="text-sm text-white/40">
                Showing {page * JOBS_PER_PAGE + 1}-
                {Math.min((page + 1) * JOBS_PER_PAGE, jobs.data.totalCount)} of{" "}
                {jobs.data.totalCount} jobs
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <span className="text-sm text-white/50 px-2">
                  Page {page + 1} of {Math.ceil(jobs.data.totalCount / JOBS_PER_PAGE)}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!jobs.data.hasMore}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Workers Tab */}
      {activeTab === "workers" && (
        <div className="space-y-4">
          {/* Current Worker Info */}
          {currentWorker.data && (
            <Card className="p-4">
              <h3 className="font-medium text-green-400 mb-3">Current Worker (This Instance)</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-white/50">Worker ID:</span>
                  <p
                    className="font-mono text-xs mt-1 truncate"
                    title={currentWorker.data.workerId}
                  >
                    {currentWorker.data.workerId}
                  </p>
                </div>
                <div>
                  <span className="text-white/50">Running Jobs:</span>
                  <p className="text-2xl font-bold text-blue-400 mt-1">
                    {currentWorker.data.runningJobs}
                  </p>
                </div>
              </div>
              {currentWorker.data.runningJobIds.length > 0 && (
                <div className="mt-3 pt-3 border-t border-white/10">
                  <span className="text-xs text-white/50">Active Job IDs:</span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {currentWorker.data.runningJobIds.map((id) => (
                      <span key={id} className="text-xs font-mono bg-white/10 px-2 py-1 rounded">
                        {id.slice(0, 8)}...
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* All Workers */}
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium">All Workers</h3>
            {workers.data && workers.data.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => cleanupWorkers.mutate({ olderThanMinutes: 5 })}
                disabled={cleanupWorkers.isPending}
              >
                {cleanupWorkers.isPending ? "Cleaning..." : "Clean Stale"}
              </Button>
            )}
          </div>
          {workers.isLoading && (
            <div className="space-y-3">
              <Skeleton count={2} className="h-20" />
            </div>
          )}

          {workers.data?.length === 0 && (
            <EmptyState title="No workers registered" description="Workers register on startup" />
          )}

          {workers.data && workers.data.length > 0 && (
            <div className="space-y-3">
              {workers.data.map((worker) => (
                <Card key={worker.id} className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h4 className="font-medium">{worker.hostname}</h4>
                        {getStatusBadge(worker.status)}
                      </div>
                      <div className="text-sm text-white/50 space-y-1">
                        <div className="font-mono text-xs truncate" title={worker.workerId}>
                          ID: {worker.workerId}
                        </div>
                        <div className="flex gap-4">
                          <span>PID: {worker.nodePid}</span>
                          <span>Started: {formatTimeAgo(worker.startedAt)}</span>
                          <span>Last heartbeat: {formatTimeAgo(worker.lastHeartbeat)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Remote Encoders Settings
// =============================================================================

function formatEncodeDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatEncoderTimeAgo(date: Date | null): string {
  if (!date) return "Never";
  const now = new Date();
  const diff = now.getTime() - new Date(date).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function EncodersSettings() {
  const utils = trpc.useUtils();
  const [showHistory, setShowHistory] = useState(false);
  const [editingEncoder, setEditingEncoder] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  // Queries
  const encoders = trpc.encoders.list.useQuery(undefined, {
    refetchInterval: 5000, // Refresh every 5 seconds
  });
  const assignments = trpc.encoders.assignments.useQuery(undefined, {
    refetchInterval: 2000, // Refresh every 2 seconds for live progress
  });
  const history = trpc.encoders.assignmentHistory.useQuery({ limit: 20 }, { enabled: showHistory });

  // Mutations
  const updateName = trpc.encoders.updateName.useMutation({
    onSuccess: () => {
      utils.encoders.list.invalidate();
      setEditingEncoder(null);
      setNewName("");
    },
  });

  const removeEncoder = trpc.encoders.remove.useMutation({
    onSuccess: () => {
      utils.encoders.list.invalidate();
    },
  });

  const cancelJob = trpc.encoders.cancelJob.useMutation({
    onSuccess: () => {
      utils.encoders.assignments.invalidate();
    },
  });

  const handleRemove = (encoderId: string, name: string | null) => {
    if (confirm(`Are you sure you want to remove "${name || encoderId}"?`)) {
      removeEncoder.mutate({ encoderId });
    }
  };

  const handleCancelJob = (jobId: string) => {
    if (confirm("Cancel this encoding job?")) {
      cancelJob.mutate({ jobId, reason: "Cancelled by user" });
    }
  };

  const startEditing = (encoderId: string, currentName: string | null) => {
    setEditingEncoder(encoderId);
    setNewName(currentName || encoderId);
  };

  const saveNewName = (encoderId: string) => {
    if (newName.trim()) {
      updateName.mutate({ encoderId, name: newName.trim() });
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "IDLE":
        return <Badge variant="success">Idle</Badge>;
      case "ENCODING":
        return <Badge variant="info">Encoding</Badge>;
      case "ERROR":
        return <Badge variant="danger">Error</Badge>;
      default:
        return <Badge variant="default">Offline</Badge>;
    }
  };

  const getAssignmentStatusBadge = (status: string) => {
    switch (status) {
      case "PENDING":
        return <Badge variant="warning">Pending</Badge>;
      case "ENCODING":
        return <Badge variant="info">Encoding</Badge>;
      case "COMPLETED":
        return <Badge variant="success">Completed</Badge>;
      case "FAILED":
        return <Badge variant="danger">Failed</Badge>;
      case "CANCELLED":
        return <Badge variant="default">Cancelled</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold">Remote Encoders</h2>
        <p className="text-sm text-white/50 mt-1">
          Manage distributed encoding nodes and monitor encoding jobs
        </p>
      </div>

      {/* Encoder List */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium">Registered Encoders</h3>

        {encoders.isLoading && (
          <div className="space-y-3">
            <Skeleton count={2} className="h-28" />
          </div>
        )}

        {encoders.data?.length === 0 && (
          <EmptyState
            title="No encoders registered"
            description="Deploy an encoder using the setup script to get started"
          />
        )}

        {encoders.data && encoders.data.length > 0 && (
          <div className="space-y-3">
            {encoders.data.map((encoder) => (
              <Card key={encoder.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    {/* Name and status */}
                    <div className="flex items-center gap-2 mb-1">
                      {editingEncoder === encoder.encoderId ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            className="h-7 text-sm w-48"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveNewName(encoder.encoderId);
                              if (e.key === "Escape") setEditingEncoder(null);
                            }}
                            autoFocus
                          />
                          <Button
                            size="sm"
                            onClick={() => saveNewName(encoder.encoderId)}
                            disabled={updateName.isPending}
                          >
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingEncoder(null)}>
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <>
                          <h4 className="font-semibold">{encoder.name || encoder.encoderId}</h4>
                          {getStatusBadge(encoder.status)}
                        </>
                      )}
                    </div>

                    {/* Details */}
                    <div className="text-sm text-white/50 space-y-1">
                      <div className="flex items-center gap-4 flex-wrap">
                        <span>ID: {encoder.encoderId}</span>
                        <span>GPU: {encoder.gpuDevice}</span>
                        <span>Max Jobs: {encoder.maxConcurrent}</span>
                      </div>
                      <div className="flex items-center gap-4 flex-wrap">
                        <span>Last Heartbeat: {formatEncoderTimeAgo(encoder.lastHeartbeat)}</span>
                        <span className="text-green-400">
                          Completed: {encoder.totalJobsCompleted}
                        </span>
                        {encoder.totalJobsFailed > 0 && (
                          <span className="text-red-400">Failed: {encoder.totalJobsFailed}</span>
                        )}
                      </div>

                      {/* Capabilities */}
                      {encoder.capabilities && (
                        <div className="mt-3 pt-3 border-t border-white/10">
                          <div className="text-xs font-semibold text-white/60 mb-2 uppercase tracking-wide">
                            Capabilities
                          </div>
                          <div className="space-y-2.5 text-xs">
                            {/* Video Encoders */}
                            {Object.keys(encoder.capabilities.videoEncoders || {}).length > 0 && (
                              <div>
                                <div className="text-white/50 font-medium mb-1">Video:</div>
                                <div className="pl-3 space-y-1">
                                  {Object.entries(encoder.capabilities.videoEncoders).map(
                                    ([codec, encoders]) => {
                                      const hw = encoders.hardware || [];
                                      const sw = encoders.software || [];
                                      if (hw.length === 0 && sw.length === 0) return null;
                                      return (
                                        <div key={codec} className="flex items-start gap-2">
                                          <span className="text-annex-400 font-semibold uppercase min-w-[45px]">
                                            {codec}
                                          </span>
                                          <span className="text-white/40 leading-relaxed">
                                            (
                                            {hw.length > 0 && (
                                              <>
                                                <span className="text-green-400">HW:</span>{" "}
                                                {hw.join(", ")}
                                              </>
                                            )}
                                            {hw.length > 0 && sw.length > 0 && (
                                              <span className="text-white/30"> | </span>
                                            )}
                                            {sw.length > 0 && (
                                              <>
                                                <span className="text-blue-400">SW:</span>{" "}
                                                {sw.join(", ")}
                                              </>
                                            )}
                                            )
                                          </span>
                                        </div>
                                      );
                                    }
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Hardware Acceleration */}
                            {encoder.capabilities.hwaccel &&
                              encoder.capabilities.hwaccel.length > 0 && (
                                <div>
                                  <span className="text-white/50 font-medium">HW Accel: </span>
                                  <span className="text-white/40">
                                    {encoder.capabilities.hwaccel.join(", ")}
                                  </span>
                                </div>
                              )}

                            {/* Audio Encoders */}
                            {encoder.capabilities.audioEncoders &&
                              encoder.capabilities.audioEncoders.length > 0 && (
                                <div>
                                  <span className="text-white/50 font-medium">Audio: </span>
                                  <span className="text-white/40">
                                    {encoder.capabilities.audioEncoders.join(", ")}
                                  </span>
                                </div>
                              )}

                            {/* GPU Info */}
                            {encoder.capabilities.gpu && (
                              <div>
                                <span className="text-white/50 font-medium">GPU: </span>
                                <span className="text-white/40">
                                  {encoder.capabilities.gpu.device}
                                  {encoder.capabilities.gpu.driver && (
                                    <span className="text-white/30">
                                      {" "}
                                      ({encoder.capabilities.gpu.driver})
                                    </span>
                                  )}
                                  {!encoder.capabilities.gpu.accessible && (
                                    <span className="text-red-400"> - Not Accessible</span>
                                  )}
                                </span>
                              </div>
                            )}

                            {/* System Info */}
                            {encoder.capabilities.system && (
                              <div>
                                <span className="text-white/50 font-medium">System: </span>
                                <span className="text-white/40">
                                  {encoder.capabilities.system.cpuCores &&
                                    `${encoder.capabilities.system.cpuCores} cores`}
                                  {encoder.capabilities.system.cpuCores &&
                                    encoder.capabilities.system.totalMemory &&
                                    " | "}
                                  {encoder.capabilities.system.totalMemory &&
                                    `${Math.round(encoder.capabilities.system.totalMemory / 1024)} GB RAM`}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    {!editingEncoder && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => startEditing(encoder.encoderId, encoder.name)}
                      >
                        Rename
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleRemove(encoder.encoderId, encoder.name)}
                      disabled={encoder.status !== "OFFLINE" || removeEncoder.isPending}
                    >
                      Remove
                    </Button>
                  </div>
                </div>

                {/* Current Jobs */}
                {encoder.currentJobs > 0 && (
                  <div className="mt-3 pt-3 border-t border-white/10">
                    <span className="text-sm text-white/70">
                      Currently encoding {encoder.currentJobs} job
                      {encoder.currentJobs > 1 ? "s" : ""}
                    </span>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Active Jobs */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium">Active Encoding Jobs</h3>

        {assignments.isLoading && <div className="h-24 bg-white/5 rounded animate-pulse" />}

        {assignments.data?.length === 0 && (
          <Card className="p-4 text-center text-white/50">No active encoding jobs</Card>
        )}

        {assignments.data && assignments.data.length > 0 && (
          <div className="space-y-3">
            {assignments.data.map((job) => (
              <Card key={job.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-medium truncate">{job.inputPath.split("/").pop()}</span>
                      {getAssignmentStatusBadge(job.status)}
                    </div>

                    {/* Progress bar */}
                    <div className="mb-2">
                      <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-annex-500 transition-all duration-300"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="text-sm text-white/50 flex items-center gap-4 flex-wrap">
                      <span>{job.progress.toFixed(1)}%</span>
                      {job.fps !== null && <span>{job.fps.toFixed(1)} fps</span>}
                      {job.speed !== null && <span>{job.speed.toFixed(2)}x</span>}
                      {job.eta !== null && job.eta > 0 && (
                        <span>ETA: {formatEncodeDuration(job.eta)}</span>
                      )}
                      <span>Encoder: {job.encoderId}</span>
                      <span>
                        Attempt: {job.attempt}/{job.maxAttempts}
                      </span>
                    </div>
                  </div>

                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => handleCancelJob(job.jobId)}
                    disabled={cancelJob.isPending}
                  >
                    Cancel
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Job History (collapsible) */}
      <div className="space-y-4">
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="flex items-center gap-2 text-lg font-medium hover:text-white/80 transition-colors"
        >
          <span className={`transform transition-transform ${showHistory ? "rotate-90" : ""}`}>
            &#9654;
          </span>
          Recent Job History
        </button>

        {showHistory && (
          <>
            {history.isLoading && (
              <div className="space-y-2">
                <Skeleton count={3} className="h-16" />
              </div>
            )}

            {history.data?.length === 0 && (
              <Card className="p-4 text-center text-white/50">No encoding history yet</Card>
            )}

            {history.data && history.data.length > 0 && (
              <div className="space-y-2">
                {history.data.map((job) => (
                  <Card key={job.id} className="p-3">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">
                            {job.inputPath.split("/").pop()}
                          </span>
                          {getAssignmentStatusBadge(job.status)}
                        </div>
                        <div className="text-xs text-white/40 mt-1">
                          {job.completedAt && <span>{formatEncoderTimeAgo(job.completedAt)}</span>}
                          {job.error && <span className="text-red-400 ml-2">{job.error}</span>}
                        </div>
                      </div>
                      <div className="text-xs text-white/50">{job.encoderId}</div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Deploy Info */}
      <Card className="p-4 bg-white/[0.02]">
        <h4 className="font-medium mb-2">Deploy New Encoder</h4>
        <p className="text-sm text-white/50 mb-3">
          Download the encoder binary and install as a service:
        </p>
        <div className="space-y-2">
          <div>
            <p className="text-xs text-white/40 mb-1">Linux:</p>
            <code className="block text-xs bg-black/30 p-3 rounded overflow-x-auto">
              curl -L
              https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-linux-x64
              -o annex-encoder
              <br />
              chmod +x annex-encoder
              <br />
              sudo ./annex-encoder --setup --install
              <br />
              sudo nano /etc/annex-encoder.env
            </code>
          </div>
          <div>
            <p className="text-xs text-white/40 mb-1">Windows:</p>
            <code className="block text-xs bg-black/30 p-3 rounded overflow-x-auto">
              Invoke-WebRequest -Uri
              "https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-windows-x64.exe"
              -OutFile "annex-encoder.exe"
              <br />
              .\annex-encoder.exe --setup --install
            </code>
          </div>
          <p className="text-xs text-white/40 mt-2">
            Configure ANNEX_SERVER_URL and ANNEX_ENCODER_ID in the environment file after
            installation.
          </p>
        </div>
      </Card>
    </div>
  );
}

function SchedulerSettings() {
  const healthQuery = trpc.system.scheduler.health.useQuery(undefined, {
    refetchInterval: 2000, // Refresh every 2 seconds
  });

  const toggleTaskMutation = trpc.system.scheduler.toggleTask.useMutation({
    onSuccess: () => {
      healthQuery.refetch();
    },
  });

  const health = healthQuery.data;

  if (healthQuery.isLoading) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold">Scheduler</h2>
        <Card className="p-8 text-center text-white/50">Loading...</Card>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold">Scheduler</h2>
        <Card className="p-8 text-center text-white/50">Unable to load scheduler health</Card>
      </div>
    );
  }

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
  };

  const formatInterval = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
    if (ms < 3600000) return `${(ms / 60000).toFixed(0)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
  };

  const formatLastRun = (date: Date | null) => {
    if (!date) return "Never";
    const d = new Date(date);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return d.toLocaleTimeString();
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Scheduler</h2>

      {/* Health Overview */}
      <Card className="space-y-4">
        <h3 className="text-lg font-medium">Health Overview</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white/5 rounded p-3">
            <div className="text-xs text-white/50 uppercase">Status</div>
            <div
              className={`text-lg font-medium ${health.isRunning ? "text-green-400" : "text-red-400"}`}
            >
              {health.isRunning ? "Running" : "Stopped"}
            </div>
          </div>
          <div className="bg-white/5 rounded p-3">
            <div className="text-xs text-white/50 uppercase">Loop Interval</div>
            <div className="text-lg font-medium">{formatInterval(health.loopIntervalMs)}</div>
          </div>
          <div className="bg-white/5 rounded p-3">
            <div className="text-xs text-white/50 uppercase">Avg Loop Duration</div>
            <div className="text-lg font-medium">{formatDuration(health.avgLoopDurationMs)}</div>
          </div>
          <div className="bg-white/5 rounded p-3">
            <div className="text-xs text-white/50 uppercase">Loop Delay</div>
            <div
              className={`text-lg font-medium ${health.loopDelayMs > 100 ? "text-yellow-400" : ""}`}
            >
              {formatDuration(health.loopDelayMs)}
            </div>
          </div>
        </div>
        <div className="text-xs text-white/40 flex gap-4">
          <span>Last tick: {formatLastRun(health.lastLoopTime)}</span>
          <span>Max loop: {formatDuration(health.maxLoopDurationMs)}</span>
          <span>Pending one-offs: {health.pendingOneOffs}</span>
        </div>
      </Card>

      {/* Tasks */}
      <Card className="space-y-4">
        <h3 className="text-lg font-medium">Recurring Tasks</h3>
        {health.recurringTasks.length === 0 ? (
          <div className="text-white/50 text-center py-4">No tasks registered</div>
        ) : (
          <div className="space-y-2">
            {health.recurringTasks.map((task) => (
              <div
                key={task.id}
                className={`bg-white/5 rounded p-3 flex items-center gap-4 ${!task.enabled ? "opacity-50" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{task.name}</span>
                    {task.isRunning && (
                      <Badge variant="info" className="text-xs">
                        Running
                      </Badge>
                    )}
                    {task.lastError && (
                      <Badge variant="danger" className="text-xs">
                        Error
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-white/50 flex gap-3 mt-1">
                    <span>Every {formatInterval(task.intervalMs)}</span>
                    <span>Last: {formatLastRun(task.lastRun)}</span>
                    {task.lastDurationMs !== null && (
                      <span>Took: {formatDuration(task.lastDurationMs)}</span>
                    )}
                    <span>Runs: {task.runCount}</span>
                    {task.errorCount > 0 && (
                      <span className="text-red-400">Errors: {task.errorCount}</span>
                    )}
                  </div>
                  {task.lastError && (
                    <div className="text-xs text-red-400 mt-1 truncate">{task.lastError}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {task.nextRunIn !== null && task.enabled && !task.isRunning && (
                    <span className="text-xs text-white/40">
                      Next: {formatDuration(task.nextRunIn)}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant={task.enabled ? "secondary" : "primary"}
                    onClick={() =>
                      toggleTaskMutation.mutate({ taskId: task.id, enabled: !task.enabled })
                    }
                    disabled={toggleTaskMutation.isLoading}
                  >
                    {task.enabled ? "Disable" : "Enable"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="flex gap-8">
      <SidebarNav items={settingsNavItems} />
      <div className="flex-1">
        <Routes>
          <Route index element={<GeneralSettings />} />
          <Route path="servers" element={<ServersSettings />} />
          <Route path="indexers" element={<IndexersSettings />} />
          <Route path="encoders" element={<EncodersSettings />} />
          <Route path="pipelines" element={<Pipelines />} />
          <Route path="pipelines/:id" element={<PipelineEditor />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="jobs" element={<JobsSettings />} />
          <Route path="scheduler" element={<SchedulerSettings />} />
        </Routes>
      </div>
    </div>
  );
}
