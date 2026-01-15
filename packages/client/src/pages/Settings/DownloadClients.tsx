import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Select,
  Skeleton,
} from "../../components/ui";
import { trpc } from "../../trpc";

interface DownloadClient {
  id: string;
  name: string;
  type: string;
  url: string;
  username: string | null;
  priority: number;
  enabled: boolean;
  supportedTypes: string[];
  baseDir: string | null;
  isHealthy: boolean;
  lastHealthCheck: Date | null;
  lastError: string | null;
  totalDownloads: number;
  activeDownloads: number;
}

interface DownloadClientFormData {
  name: string;
  type: "qbittorrent" | "sabnzbd" | "nzbget";
  url: string;
  username?: string;
  password?: string;
  apiKey?: string;
  priority: number;
  enabled: boolean;
  baseDir?: string;
  hasPassword?: boolean;
  hasApiKey?: boolean;
}

const defaultClientForm: DownloadClientFormData = {
  name: "",
  type: "qbittorrent",
  url: "",
  username: "",
  password: "",
  apiKey: "",
  priority: 50,
  enabled: true,
  baseDir: "",
};

function DownloadClientForm({
  initialData,
  onSave,
  onCancel,
  isSaving,
}: {
  initialData?: DownloadClientFormData;
  onSave: (data: DownloadClientFormData) => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const [form, setForm] = useState<DownloadClientFormData>(initialData ?? defaultClientForm);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const updateForm = <K extends keyof DownloadClientFormData>(
    key: K,
    value: DownloadClientFormData[K]
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(form);
  };

  const handleTest = async () => {
    if (!form.url) return;

    setIsTesting(true);
    setTestResult(null);

    try {
      // For testing, we need to create a temporary client if editing
      // or we need the ID if we're editing
      if (initialData) {
        // For edit mode, we can't test without saving first
        alert("Please save the client first before testing");
        setIsTesting(false);
        return;
      }

      // For new clients, we can't test until saved
      alert("Please save the client first before testing");
      setIsTesting(false);
    } catch (error) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      setIsTesting(false);
    }
  };

  const requiresUsername = form.type === "qbittorrent" || form.type === "nzbget";
  const requiresPassword = form.type === "qbittorrent" || form.type === "nzbget";
  const requiresApiKey = form.type === "sabnzbd";

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Basic Info */}
      <Card className="space-y-4">
        <h3 className="text-lg font-medium">Basic Information</h3>

        <div>
          <Label>Client Type</Label>
          <Select
            value={form.type}
            onChange={(e) => updateForm("type", e.target.value as DownloadClientFormData["type"])}
            disabled={!!initialData}
          >
            <option value="qbittorrent">qBittorrent (Torrent)</option>
            <option value="sabnzbd">SABnzbd (Usenet)</option>
            <option value="nzbget">NZBGet (Usenet)</option>
          </Select>
          {initialData && (
            <p className="text-xs text-surface-500 mt-1">Client type cannot be changed</p>
          )}
        </div>

        <div>
          <Label>Name</Label>
          <Input
            type="text"
            value={form.name}
            onChange={(e) => updateForm("name", e.target.value)}
            placeholder="qBittorrent"
            required
          />
        </div>

        <div>
          <Label>URL</Label>
          <Input
            type="url"
            value={form.url}
            onChange={(e) => updateForm("url", e.target.value)}
            placeholder="http://localhost:8080"
            required
          />
        </div>

        <div>
          <Label>Priority (1-100, higher = preferred)</Label>
          <Input
            type="number"
            min="1"
            max="100"
            value={form.priority}
            onChange={(e) => updateForm("priority", parseInt(e.target.value, 10))}
            required
          />
        </div>

        <div>
          <Label>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => updateForm("enabled", e.target.checked)}
              className="mr-2"
            />
            Enabled
          </Label>
        </div>
      </Card>

      {/* Authentication */}
      <Card className="space-y-4">
        <h3 className="text-lg font-medium">Authentication</h3>

        {requiresUsername && (
          <div>
            <Label>Username</Label>
            <Input
              type="text"
              value={form.username || ""}
              onChange={(e) => updateForm("username", e.target.value)}
              placeholder="admin"
            />
          </div>
        )}

        {requiresPassword && (
          <div>
            <Label>Password</Label>
            <Input
              type="password"
              value={form.password || ""}
              onChange={(e) => updateForm("password", e.target.value)}
              placeholder={initialData?.hasPassword ? "(existing password)" : ""}
            />
            {initialData?.hasPassword && !form.password && (
              <p className="text-xs text-surface-500 mt-1">Leave blank to keep existing password</p>
            )}
          </div>
        )}

        {requiresApiKey && (
          <div>
            <Label>API Key</Label>
            <Input
              type="text"
              value={form.apiKey || ""}
              onChange={(e) => updateForm("apiKey", e.target.value)}
              placeholder={initialData?.hasApiKey ? "(existing API key)" : ""}
              required={!initialData}
            />
            {initialData?.hasApiKey && !form.apiKey && (
              <p className="text-xs text-surface-500 mt-1">Leave blank to keep existing API key</p>
            )}
          </div>
        )}
      </Card>

      {/* Advanced */}
      <Card className="space-y-4">
        <h3 className="text-lg font-medium">Advanced</h3>

        <div>
          <Label>Base Directory (optional)</Label>
          <Input
            type="text"
            value={form.baseDir || ""}
            onChange={(e) => updateForm("baseDir", e.target.value)}
            placeholder="/path/to/downloads"
          />
          <p className="text-xs text-surface-500 mt-1">
            Override client's reported download path for path mapping
          </p>
        </div>
      </Card>

      {/* Test Result */}
      {testResult && (
        <div
          className={`p-3 rounded text-sm ${
            testResult.success ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
          }`}
        >
          {testResult.success ? "Connection successful!" : `Connection failed: ${testResult.error}`}
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
            {isSaving ? "Saving..." : "Save Client"}
          </Button>
        </div>
      </div>
    </form>
  );
}

export default function DownloadClientsSettings() {
  const utils = trpc.useUtils();
  const clients = trpc.downloadClients.list.useQuery();
  const [showForm, setShowForm] = useState(false);
  const [editingClient, setEditingClient] = useState<string | null>(null);

  const createClient = trpc.downloadClients.create.useMutation({
    onSuccess: () => {
      utils.downloadClients.list.invalidate();
      setShowForm(false);
    },
  });

  const updateClient = trpc.downloadClients.update.useMutation({
    onSuccess: () => {
      utils.downloadClients.list.invalidate();
      setEditingClient(null);
    },
  });

  const deleteClient = trpc.downloadClients.delete.useMutation({
    onSuccess: () => {
      utils.downloadClients.list.invalidate();
    },
  });

  const testClient = trpc.downloadClients.test.useMutation();

  const handleCreate = (data: DownloadClientFormData) => {
    createClient.mutate({
      name: data.name,
      type: data.type,
      url: data.url,
      username: data.username,
      password: data.password,
      apiKey: data.apiKey,
      priority: data.priority,
      enabled: data.enabled,
      baseDir: data.baseDir,
    });
  };

  const handleUpdate = (id: string, data: DownloadClientFormData) => {
    updateClient.mutate({
      id,
      name: data.name,
      type: data.type,
      url: data.url,
      username: data.username,
      password: data.password || undefined,
      apiKey: data.apiKey || undefined,
      priority: data.priority,
      enabled: data.enabled,
      baseDir: data.baseDir,
    });
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete "${name}"?`)) {
      deleteClient.mutate({ id });
    }
  };

  const handleTest = async (id: string) => {
    const result = await testClient.mutateAsync({ id });
    alert(
      result.success
        ? `Connection successful! ${result.version ? `Version: ${result.version}` : ""}`
        : `Connection failed: ${result.error}`
    );
  };

  // Show form for creating new client
  if (showForm) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold">Add Download Client</h2>
        <DownloadClientForm
          onSave={handleCreate}
          onCancel={() => setShowForm(false)}
          isSaving={createClient.isPending}
        />
      </div>
    );
  }

  // Show form for editing existing client
  if (editingClient) {
    const client = clients.data?.find((c: DownloadClient) => c.id === editingClient);
    if (client) {
      const formData: DownloadClientFormData = {
        name: client.name,
        type: client.type as DownloadClientFormData["type"],
        url: client.url,
        username: client.username || "",
        password: "",
        apiKey: "",
        priority: client.priority,
        enabled: client.enabled,
        baseDir: client.baseDir || "",
        hasPassword: client.type === "qbittorrent" || client.type === "nzbget",
        hasApiKey: client.type === "sabnzbd",
      };

      return (
        <div className="space-y-6">
          <h2 className="text-xl font-semibold">Edit Download Client</h2>
          <DownloadClientForm
            initialData={formData}
            onSave={(data) => handleUpdate(editingClient, data)}
            onCancel={() => setEditingClient(null)}
            isSaving={updateClient.isPending}
          />
        </div>
      );
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Download Clients</h2>
        <Button onClick={() => setShowForm(true)}>Add Client</Button>
      </div>

      {clients.isLoading && (
        <div className="space-y-4">
          <Skeleton count={2} className="h-20" />
        </div>
      )}

      {clients.data?.length === 0 && (
        <EmptyState
          title="No download clients configured"
          description="Add qBittorrent for torrents or SABnzbd/NZBGet for Usenet downloads"
        />
      )}

      {clients.data && clients.data.length > 0 && (
        <div className="space-y-3">
          {clients.data.map((client: DownloadClient) => (
            <Card key={client.id} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <h3 className="font-medium">{client.name}</h3>
                    <Badge variant={client.enabled ? "success" : "default"}>
                      {client.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    {client.enabled && (
                      <Badge variant={client.isHealthy ? "success" : "danger"}>
                        {client.isHealthy ? "Healthy" : "Unhealthy"}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-white/50 mt-1">
                    {client.type.toUpperCase()} • Priority: {client.priority} • Supports:{" "}
                    {client.supportedTypes.join(", ")}
                  </p>
                  {client.activeDownloads > 0 && (
                    <p className="text-sm text-white/40 mt-1">
                      Active: {client.activeDownloads} • Total: {client.totalDownloads}
                    </p>
                  )}
                  {!client.isHealthy && client.lastError && (
                    <p className="text-sm text-red-400 mt-1">Error: {client.lastError}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleTest(client.id)}
                    disabled={testClient.isPending}
                  >
                    Test
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditingClient(client.id)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(client.id, client.name)}
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
