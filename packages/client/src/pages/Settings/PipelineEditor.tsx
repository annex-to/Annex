import { useState, useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { trpc } from "../../trpc";
import { Button, Input, Card, Label } from "../../components/ui";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Node,
  Edge,
  Connection,
  BackgroundVariant,
  ConnectionLineType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import StepNode from "../../components/pipeline/StepNode";
import StepConfigModal from "../../components/pipeline/StepConfigModal";

const nodeTypes = {
  step: StepNode,
};

type StepType = "START" | "SEARCH" | "DOWNLOAD" | "ENCODE" | "DELIVER" | "APPROVAL" | "NOTIFICATION";

interface StepData extends Record<string, unknown> {
  label: string;
  type: StepType;
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
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StepData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

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

  // Initialize with start node
  useEffect(() => {
    if (nodes.length === 0 && !isEditing) {
      const startNode: Node<StepData> = {
        id: "start",
        type: "step",
        position: { x: 250, y: 50 },
        data: {
          label: "Request Submitted",
          type: "START",
          config: {},
          required: true,
          retryable: false,
          continueOnError: false,
        },
        deletable: false,
      };
      setNodes([startNode]);
    }
  }, [nodes.length, isEditing, setNodes]);

  // Load existing pipeline
  useEffect(() => {
    if (pipeline && pipeline.steps) {
      setName(pipeline.name);
      setDescription(pipeline.description || "");
      setMediaType(pipeline.mediaType as "MOVIE" | "TV");
      setIsDefault(pipeline.isDefault);
      setIsPublic(pipeline.isPublic);

      // Convert steps to nodes and edges
      const loadedNodes: Node<StepData>[] = [
        {
          id: "start",
          type: "step",
          position: { x: 250, y: 50 },
          data: {
            label: "Request Submitted",
            type: "START",
            config: {},
            required: true,
            retryable: false,
            continueOnError: false,
          },
          deletable: false,
        },
      ];

      const loadedEdges: Edge[] = [];
      let yPosition = 200;

      pipeline.steps.forEach((step, index) => {
        const nodeId = `step-${index}`;
        loadedNodes.push({
          id: nodeId,
          type: "step",
          position: { x: 250, y: yPosition },
          data: {
            label: step.name,
            type: step.type as StepType,
            config: (step.config as Record<string, unknown>) || {},
            required: step.required,
            retryable: step.retryable,
            continueOnError: step.continueOnError,
          },
        });

        // Connect to previous node
        const sourceId = index === 0 ? "start" : `step-${index - 1}`;
        loadedEdges.push({
          id: `e${sourceId}-${nodeId}`,
          source: sourceId,
          target: nodeId,
          type: "smoothstep",
          animated: true,
          style: { stroke: "rgba(239, 68, 68, 0.5)", strokeWidth: 2 },
        });

        yPosition += 150;
      });

      setNodes(loadedNodes);
      setEdges(loadedEdges);
    }
  }, [pipeline, setNodes, setEdges]);

  const onConnect = useCallback(
    (params: Connection) =>
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            type: "smoothstep",
            animated: true,
            style: { stroke: "rgba(239, 68, 68, 0.5)", strokeWidth: 2 },
          },
          eds
        )
      ),
    [setEdges]
  );

  const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: Node) => {
    if (node.id !== "start") {
      setSelectedNode(node.id);
    }
  }, []);

  const addNode = (type: StepType) => {
    const stepLabels: Record<StepType, string> = {
      START: "Request Submitted",
      SEARCH: "Search for Release",
      DOWNLOAD: "Download Content",
      ENCODE: "Encode Media",
      DELIVER: "Deliver to Servers",
      APPROVAL: "Manual Approval",
      NOTIFICATION: "Send Notification",
    };

    const newNode: Node<StepData> = {
      id: `step-${Date.now()}`,
      type: "step",
      position: { x: Math.random() * 400 + 50, y: Math.random() * 400 + 100 },
      data: {
        label: stepLabels[type],
        type,
        config: {},
        required: true,
        retryable: true,
        continueOnError: false,
      },
    };

    setNodes((nds) => [...nds, newNode]);
  };

  const updateNodeData = (nodeId: string, updates: Partial<StepData>) => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === nodeId) {
          return {
            ...node,
            data: { ...node.data, ...updates },
          };
        }
        return node;
      })
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate: check for merges (multiple edges to same target)
    const targetCounts = new Map<string, number>();
    edges.forEach((edge) => {
      if (edge.target !== "start") {
        targetCounts.set(edge.target, (targetCounts.get(edge.target) || 0) + 1);
      }
    });

    const mergeNodes = Array.from(targetCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([nodeId]) => nodes.find((n) => n.id === nodeId)?.data.label);

    if (mergeNodes.length > 0) {
      alert(
        `Pipeline validation failed: Merging branches is not supported.\n\n` +
          `The following steps have multiple incoming connections:\n${mergeNodes.join(", ")}\n\n` +
          `Please ensure each step has at most one incoming connection.`
      );
      return;
    }

    // Validate: check for cycles
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const hasCycle = (nodeId: string): boolean => {
      if (!visited.has(nodeId)) {
        visited.add(nodeId);
        recStack.add(nodeId);

        const outgoing = edges.filter((e) => e.source === nodeId);
        for (const edge of outgoing) {
          if (!visited.has(edge.target) && hasCycle(edge.target)) {
            return true;
          } else if (recStack.has(edge.target)) {
            return true;
          }
        }
      }
      recStack.delete(nodeId);
      return false;
    };

    if (hasCycle("start")) {
      alert("Pipeline validation failed: Cycles are not allowed. Please remove any circular connections.");
      return;
    }

    // Convert nodes and edges to steps in order
    const orderedSteps = getOrderedSteps();
    if (orderedSteps.length === 0) {
      alert("Please add at least one step to the pipeline");
      return;
    }

    const steps = orderedSteps
      .filter((node) => node.data.type !== "START")
      .map((node) => {
        const data = node.data;
        return {
          type: data.type as Exclude<StepType, "START">,
          name: data.label,
          config: data.config,
          required: data.required,
          retryable: data.retryable,
          continueOnError: data.continueOnError,
        };
      });

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

  // Get steps in execution order by following edges from start node
  // Supports branching (multiple outgoing edges) but not merging (multiple incoming edges)
  const getOrderedSteps = (): Node<StepData>[] => {
    const ordered: Node<StepData>[] = [];
    const visited = new Set<string>();

    // Depth-first traversal to collect all branches
    const traverse = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);

      // Find all outgoing edges from this node
      const outgoingEdges = edges.filter((e) => e.source === nodeId && !visited.has(e.target));

      // Process each branch
      for (const edge of outgoingEdges) {
        const nextNode = nodes.find((n) => n.id === edge.target);
        if (nextNode && nextNode.id !== "start") {
          ordered.push(nextNode);
          traverse(edge.target); // Recursively traverse this branch
        }
      }
    };

    traverse("start");
    return ordered;
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
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
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

            <div className="col-span-2">
              <Label>Description</Label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white placeholder-white/25 resize-none"
                rows={2}
              />
            </div>

            <div className="col-span-2 flex gap-4">
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
            <h2 className="text-lg font-semibold text-white">Pipeline Flow</h2>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => addNode("SEARCH")}>
                + Search
              </Button>
              <Button type="button" size="sm" onClick={() => addNode("DOWNLOAD")}>
                + Download
              </Button>
              <Button type="button" size="sm" onClick={() => addNode("ENCODE")}>
                + Encode
              </Button>
              <Button type="button" size="sm" onClick={() => addNode("DELIVER")}>
                + Deliver
              </Button>
              <Button type="button" size="sm" onClick={() => addNode("APPROVAL")}>
                + Approval
              </Button>
              <Button type="button" size="sm" onClick={() => addNode("NOTIFICATION")}>
                + Notification
              </Button>
            </div>
          </div>

          <div style={{ height: "600px" }} className="rounded border border-white/10 overflow-hidden">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeDoubleClick={onNodeDoubleClick}
              nodeTypes={nodeTypes}
              fitView
              deleteKeyCode={["Backspace", "Delete"]}
              multiSelectionKeyCode={["Control", "Meta"]}
              className="bg-gradient-to-br from-black via-black to-annex-950/20"
              style={{
                background: "linear-gradient(135deg, #000000 0%, #000000 50%, rgba(239, 68, 68, 0.05) 100%)",
              }}
              defaultEdgeOptions={{
                type: "smoothstep",
                animated: true,
                style: { stroke: "rgba(239, 68, 68, 0.5)", strokeWidth: 2 },
              }}
              connectionLineStyle={{ stroke: "rgba(239, 68, 68, 0.5)", strokeWidth: 2 }}
              connectionLineType={ConnectionLineType.SmoothStep}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={16}
                size={1}
                color="rgba(239, 68, 68, 0.15)"
                style={{ opacity: 0.5 }}
              />
              <Controls />
              <MiniMap
                nodeColor={(node) => {
                  const data = node.data as StepData;
                  const colors: Record<StepType, string> = {
                    START: "#ef4444",
                    SEARCH: "#3b82f6",
                    DOWNLOAD: "#8b5cf6",
                    ENCODE: "#f59e0b",
                    DELIVER: "#10b981",
                    APPROVAL: "#eab308",
                    NOTIFICATION: "#06b6d4",
                  };
                  return colors[data.type] || "#ffffff";
                }}
                maskColor="rgba(0, 0, 0, 0.7)"
              />
            </ReactFlow>
          </div>
          <div className="mt-2 text-xs text-white/50">
            Double-click a node to configure it. Select nodes or connections and press Delete/Backspace to remove
            them.
          </div>
        </Card>

        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={createMutation.isPending || updateMutation.isPending}
          >
            {isEditing ? "Update Template" : "Create Template"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate("/settings/pipelines")}>
            Cancel
          </Button>
        </div>
      </form>

      {selectedNode && nodes.find((n) => n.id === selectedNode) && (
        <StepConfigModal
          nodeId={selectedNode}
          nodeData={nodes.find((n) => n.id === selectedNode)!.data}
          onClose={() => setSelectedNode(null)}
          onUpdate={(updates) => {
            updateNodeData(selectedNode, updates);
            setSelectedNode(null);
          }}
        />
      )}
    </div>
  );
}
