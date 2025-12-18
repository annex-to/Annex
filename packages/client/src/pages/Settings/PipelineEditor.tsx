import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { trpc } from "../../trpc";
import { Button, Input, Card, Label } from "../../components/ui";

interface Step {
  type: "SEARCH" | "DOWNLOAD" | "ENCODE" | "DELIVER" | "APPROVAL" | "NOTIFICATION";
  name: string;
  config: Record<string, unknown>;
  required: boolean;
  retryable: boolean;
  continueOnError: boolean;
}

export default function PipelineEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEditing = id !== "new";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mediaType, setMediaType] = useState<"MOVIE" | "TV">("MOVIE");
  const [isDefault, setIsDefault] = useState(false);
  const [isPublic, setIsPublic] = useState(true);
  const [steps, setSteps] = useState<Step[]>([]);

  const { data: pipeline } = trpc.pipelines.get.useQuery({ id: id! }, { enabled: isEditing });
  const utils = trpc.useUtils();

  const createMutation = trpc.pipelines.create.useMutation({
    onSuccess: () => {
      utils.pipelines.list.invalidate();
      navigate("/settings/pipelines");
    },
  });

  const updateMutation = trpc.pipelines.update.useMutation({
    onSuccess: () => {
      utils.pipelines.list.invalidate();
      navigate("/settings/pipelines");
    },
  });

  useEffect(() => {
    if (pipeline) {
      setName(pipeline.name);
      setDescription(pipeline.description || "");
      setMediaType(pipeline.mediaType as "MOVIE" | "TV");
      setIsDefault(pipeline.isDefault);
      setIsPublic(pipeline.isPublic);
      setSteps(
        pipeline.steps.map((s) => ({
          type: s.type as Step["type"],
          name: s.name,
          config: (s.config as Record<string, unknown>) || {},
          required: s.required,
          retryable: s.retryable,
          continueOnError: s.continueOnError,
        }))
      );
    }
  }, [pipeline]);

  const addStep = (type: Step["type"]) => {
    const stepNames: Record<Step["type"], string> = {
      SEARCH: "Search for Release",
      DOWNLOAD: "Download Content",
      ENCODE: "Encode Media",
      DELIVER: "Deliver to Servers",
      APPROVAL: "Manual Approval",
      NOTIFICATION: "Send Notification",
    };

    setSteps([
      ...steps,
      {
        type,
        name: stepNames[type],
        config: {},
        required: true,
        retryable: true,
        continueOnError: false,
      },
    ]);
  };

  const removeStep = (index: number) => {
    setSteps(steps.filter((_, i) => i !== index));
  };

  const moveStep = (index: number, direction: "up" | "down") => {
    const newSteps = [...steps];
    if (direction === "up" && index > 0) {
      [newSteps[index - 1], newSteps[index]] = [newSteps[index], newSteps[index - 1]];
    } else if (direction === "down" && index < steps.length - 1) {
      [newSteps[index], newSteps[index + 1]] = [newSteps[index + 1], newSteps[index]];
    }
    setSteps(newSteps);
  };

  const updateStep = (index: number, updates: Partial<Step>) => {
    const newSteps = [...steps];
    newSteps[index] = { ...newSteps[index], ...updates };
    setSteps(newSteps);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const data = {
      name,
      description,
      mediaType,
      isDefault,
      isPublic,
      steps,
    };

    try {
      if (isEditing) {
        await updateMutation.mutateAsync({ id: id!, data });
      } else {
        await createMutation.mutateAsync(data);
      }
    } catch (error) {
      alert(`Failed to save: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const getStepIcon = (type: Step["type"]) => {
    const icons: Record<Step["type"], string> = {
      SEARCH: "🔍",
      DOWNLOAD: "⬇️",
      ENCODE: "🎬",
      DELIVER: "📦",
      APPROVAL: "✋",
      NOTIFICATION: "🔔",
    };
    return icons[type];
  };

  return (
    <div className="p-6">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="secondary" onClick={() => navigate("/settings/pipelines")}>
          ← Back
        </Button>
        <h1 className="text-2xl font-bold text-white">
          {isEditing ? "Edit Pipeline" : "Create Pipeline"}
        </h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Template Details</h2>
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>

            <div>
              <Label>Description</Label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white placeholder-white/25 resize-none"
                rows={2}
              />
            </div>

            <div>
              <Label>Media Type</Label>
              <select
                value={mediaType}
                onChange={(e) => setMediaType(e.target.value as "MOVIE" | "TV")}
                className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white"
              >
                <option value="MOVIE">Movie</option>
                <option value="TV">TV Show</option>
              </select>
            </div>

            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                />
                <span className="text-white">Default template</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                />
                <span className="text-white">Public</span>
              </label>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Steps</h2>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => addStep("SEARCH")}>
                + Search
              </Button>
              <Button type="button" size="sm" onClick={() => addStep("DOWNLOAD")}>
                + Download
              </Button>
              <Button type="button" size="sm" onClick={() => addStep("ENCODE")}>
                + Encode
              </Button>
              <Button type="button" size="sm" onClick={() => addStep("DELIVER")}>
                + Deliver
              </Button>
              <Button type="button" size="sm" onClick={() => addStep("APPROVAL")}>
                + Approval
              </Button>
              <Button type="button" size="sm" onClick={() => addStep("NOTIFICATION")}>
                + Notification
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            {steps.length === 0 ? (
              <div className="text-center py-8 text-white/60">
                No steps added. Click the buttons above to add steps.
              </div>
            ) : (
              steps.map((step, index) => (
                <div
                  key={index}
                  className="bg-white/5 border border-white/10 rounded p-4 flex items-start gap-4"
                >
                  <div className="text-2xl">{getStepIcon(step.type)}</div>

                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-white/40 font-mono">{index + 1}.</span>
                      <Input
                        value={step.name}
                        onChange={(e) => updateStep(index, { name: e.target.value })}
                        className="flex-1"
                      />
                    </div>

                    <div className="flex gap-3 text-sm">
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={step.required}
                          onChange={(e) => updateStep(index, { required: e.target.checked })}
                        />
                        <span className="text-white/70">Required</span>
                      </label>

                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={step.retryable}
                          onChange={(e) => updateStep(index, { retryable: e.target.checked })}
                        />
                        <span className="text-white/70">Retryable</span>
                      </label>

                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={step.continueOnError}
                          onChange={(e) => updateStep(index, { continueOnError: e.target.checked })}
                        />
                        <span className="text-white/70">Continue on Error</span>
                      </label>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => moveStep(index, "up")}
                      disabled={index === 0}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => moveStep(index, "down")}
                      disabled={index === steps.length - 1}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => removeStep(index)}
                    >
                      ×
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={createMutation.isPending || updateMutation.isPending || steps.length === 0}
          >
            {isEditing ? "Update Template" : "Create Template"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate("/settings/pipelines")}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
