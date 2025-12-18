import { useState } from "react";
import { trpc } from "../../trpc";
import { Button, Input, Card, Badge, Label, EmptyState } from "../../components/ui";

export default function Notifications() {
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data: configs, isLoading } = trpc.notifications.list.useQuery();
  const { data: availableEvents } = trpc.notifications.availableEvents.useQuery();
  const utils = trpc.useUtils();

  const createMutation = trpc.notifications.create.useMutation({
    onSuccess: () => {
      utils.notifications.list.invalidate();
      setIsCreating(false);
    },
  });

  const updateMutation = trpc.notifications.update.useMutation({
    onSuccess: () => {
      utils.notifications.list.invalidate();
      setEditingId(null);
    },
  });

  const deleteMutation = trpc.notifications.delete.useMutation({
    onSuccess: () => {
      utils.notifications.list.invalidate();
    },
  });

  const testMutation = trpc.notifications.test.useMutation();

  const handleTest = async (id: string) => {
    try {
      const result = await testMutation.mutateAsync({ id });
      if (result.success) {
        alert("Test notification sent successfully");
      } else {
        alert(`Test failed: ${result.error}`);
      }
    } catch (error) {
      alert(`Test failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete notification config "${name}"?`)) return;
    try {
      await deleteMutation.mutateAsync({ id });
    } catch (error) {
      alert(`Delete failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const getProviderColor = (provider: string) => {
    switch (provider) {
      case "DISCORD":
        return "bg-blue-500/20 text-blue-400 border-blue-500/30";
      case "WEBHOOK":
        return "bg-purple-500/20 text-purple-400 border-purple-500/30";
      case "EMAIL":
        return "bg-green-500/20 text-green-400 border-green-500/30";
      case "PUSH":
        return "bg-orange-500/20 text-orange-400 border-orange-500/30";
      default:
        return "bg-white/20 text-white/70 border-white/30";
    }
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-white">Notifications</h1>
        </div>
        <div className="text-white/60">Loading...</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Notifications</h1>
        <Button onClick={() => setIsCreating(true)}>Add Notification</Button>
      </div>

      <div className="space-y-4">
        {configs && configs.length > 0 ? (
          configs.map((config) => (
            <Card key={config.id} className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-semibold text-white">{config.name}</h3>
                    <Badge className={getProviderColor(config.provider)}>{config.provider}</Badge>
                    {config.mediaType && (
                      <Badge className="bg-white/10 text-white/70 border-white/20">
                        {config.mediaType}
                      </Badge>
                    )}
                    {!config.enabled && (
                      <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Disabled</Badge>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="text-sm text-white/60">
                      <span className="font-medium">Events:</span>{" "}
                      {config.events.length > 0 ? config.events.join(", ") : "None"}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleTest(config.id)}
                    disabled={testMutation.isPending}
                  >
                    Test
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditingId(config.id)}>
                    Edit
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleDelete(config.id, config.name)}
                    disabled={deleteMutation.isPending}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </Card>
          ))
        ) : (
          <EmptyState
            icon="🔔"
            title="No notification configs"
            description="Add a notification config to receive alerts about media requests"
          />
        )}
      </div>

      {isCreating && (
        <NotificationForm
          onClose={() => setIsCreating(false)}
          onCreate={(data) => createMutation.mutate(data)}
          availableEvents={availableEvents || []}
        />
      )}

      {editingId && (
        <NotificationEditForm
          configId={editingId}
          onClose={() => setEditingId(null)}
          onUpdate={(data) => updateMutation.mutate({ id: editingId, data })}
          availableEvents={availableEvents || []}
        />
      )}
    </div>
  );
}

function NotificationForm({
  onClose,
  onCreate,
  availableEvents,
}: {
  onClose: () => void;
  onCreate: (data: {
    name: string;
    provider: "DISCORD" | "WEBHOOK" | "EMAIL" | "PUSH";
    config: Record<string, unknown>;
    events: string[];
    mediaType?: "MOVIE" | "TV";
    enabled: boolean;
  }) => void;
  availableEvents: Array<{ value: string; label: string; description: string }>;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"DISCORD" | "WEBHOOK" | "EMAIL" | "PUSH">("DISCORD");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onCreate({
      name,
      provider,
      config: { webhookUrl },
      events: selectedEvents,
      enabled,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
        <h2 className="text-xl font-bold text-white mb-4">Add Notification Config</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>

          <div>
            <Label>Provider</Label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as typeof provider)}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white"
            >
              <option value="DISCORD">Discord</option>
              <option value="WEBHOOK">Webhook</option>
              <option value="EMAIL">Email</option>
              <option value="PUSH">Push</option>
            </select>
          </div>

          {provider === "DISCORD" && (
            <div>
              <Label>Webhook URL</Label>
              <Input
                type="url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://discord.com/api/webhooks/..."
                required
              />
            </div>
          )}

          <div>
            <Label>Events</Label>
            <div className="space-y-2 mt-2">
              {availableEvents.map((event) => (
                <label key={event.value} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(event.value)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedEvents([...selectedEvents, event.value]);
                      } else {
                        setSelectedEvents(selectedEvents.filter((v) => v !== event.value));
                      }
                    }}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-white font-medium">{event.label}</div>
                    <div className="text-sm text-white/60">{event.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              id="enabled"
            />
            <label htmlFor="enabled" className="text-white cursor-pointer">
              Enabled
            </label>
          </div>

          <div className="flex gap-2 pt-4">
            <Button type="submit">Create</Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function NotificationEditForm({
  configId,
  onClose,
  onUpdate,
  availableEvents,
}: {
  configId: string;
  onClose: () => void;
  onUpdate: (data: {
    name?: string;
    config?: Record<string, unknown>;
    events?: string[];
    enabled?: boolean;
  }) => void;
  availableEvents: Array<{ value: string; label: string; description: string }>;
}) {
  const { data: config } = trpc.notifications.get.useQuery({ id: configId });
  const [name, setName] = useState(config?.name || "");
  const [selectedEvents, setSelectedEvents] = useState<string[]>(config?.events || []);
  const [enabled, setEnabled] = useState(config?.enabled ?? true);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdate({
      name,
      events: selectedEvents,
      enabled,
    });
  };

  if (!config) return null;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
        <h2 className="text-xl font-bold text-white mb-4">Edit Notification Config</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>

          <div>
            <Label>Events</Label>
            <div className="space-y-2 mt-2">
              {availableEvents.map((event) => (
                <label key={event.value} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(event.value)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedEvents([...selectedEvents, event.value]);
                      } else {
                        setSelectedEvents(selectedEvents.filter((v) => v !== event.value));
                      }
                    }}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-white font-medium">{event.label}</div>
                    <div className="text-sm text-white/60">{event.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              id="enabled-edit"
            />
            <label htmlFor="enabled-edit" className="text-white cursor-pointer">
              Enabled
            </label>
          </div>

          <div className="flex gap-2 pt-4">
            <Button type="submit">Update</Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
