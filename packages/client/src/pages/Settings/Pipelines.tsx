import { useNavigate } from "react-router-dom";
import { trpc } from "../../trpc";
import { Button, Card, Badge, EmptyState } from "../../components/ui";

export default function Pipelines() {
  const navigate = useNavigate();
  const { data: pipelines, isLoading } = trpc.pipelines.list.useQuery();
  const utils = trpc.useUtils();

  const deleteMutation = trpc.pipelines.delete.useMutation({
    onSuccess: () => {
      utils.pipelines.list.invalidate();
    },
  });

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete pipeline template "${name}"?`)) return;
    try {
      await deleteMutation.mutateAsync({ id });
    } catch (error) {
      alert(`Delete failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const getMediaTypeBadge = (type: string) => {
    return type === "MOVIE" ? (
      <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">Movie</Badge>
    ) : (
      <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30">TV</Badge>
    );
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-white">Pipeline Templates</h1>
        </div>
        <div className="text-white/60">Loading...</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Pipeline Templates</h1>
        <Button onClick={() => navigate("/settings/pipelines/new")}>Create Template</Button>
      </div>

      <div className="space-y-4">
        {pipelines && pipelines.length > 0 ? (
          pipelines.map((pipeline) => (
            <Card key={pipeline.id} className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-semibold text-white">{pipeline.name}</h3>
                    {getMediaTypeBadge(pipeline.mediaType)}
                    {pipeline.isDefault && (
                      <Badge className="bg-gold-500/20 text-gold-400 border-gold-500/30">
                        Default
                      </Badge>
                    )}
                    {!pipeline.isPublic && (
                      <Badge className="bg-white/20 text-white/70 border-white/30">
                        Private
                      </Badge>
                    )}
                  </div>

                  {pipeline.description && (
                    <p className="text-white/70 text-sm mb-3">{pipeline.description}</p>
                  )}

                  <div className="flex items-center gap-4 text-sm text-white/60">
                    <span>{pipeline.stepCount} steps</span>
                    <span>Created {new Date(pipeline.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => navigate(`/settings/pipelines/${pipeline.id}`)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleDelete(pipeline.id, pipeline.name)}
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
            icon="⚙"
            title="No pipeline templates"
            description="Create a pipeline template to customize your media request workflow"
            action={<Button onClick={() => navigate("/settings/pipelines/new")}>Create Template</Button>}
          />
        )}
      </div>
    </div>
  );
}
