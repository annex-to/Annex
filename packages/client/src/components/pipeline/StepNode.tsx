import { Handle, Position } from "@xyflow/react";

interface StepNodeData {
  label: string;
  type: "START" | "SEARCH" | "DOWNLOAD" | "ENCODE" | "DELIVER" | "APPROVAL" | "NOTIFICATION";
  config: Record<string, unknown>;
  required: boolean;
  retryable: boolean;
  continueOnError: boolean;
}

interface StepNodeProps {
  data: StepNodeData;
  selected?: boolean;
}

export default function StepNode({ data, selected }: StepNodeProps) {
  const getIcon = () => {
    const icons: Record<StepNodeData["type"], string> = {
      START: "🎬",
      SEARCH: "🔍",
      DOWNLOAD: "⬇️",
      ENCODE: "🎬",
      DELIVER: "📦",
      APPROVAL: "✋",
      NOTIFICATION: "🔔",
    };
    return icons[data.type];
  };

  const getColor = () => {
    const colors: Record<StepNodeData["type"], string> = {
      START: "from-annex-500 to-annex-600",
      SEARCH: "from-blue-500 to-blue-600",
      DOWNLOAD: "from-purple-500 to-purple-600",
      ENCODE: "from-orange-500 to-orange-600",
      DELIVER: "from-green-500 to-green-600",
      APPROVAL: "from-gold-500 to-yellow-600",
      NOTIFICATION: "from-cyan-500 to-cyan-600",
    };
    return colors[data.type];
  };

  return (
    <div
      className={`
        px-4 py-3 rounded border-2 min-w-[200px]
        bg-gradient-to-br ${getColor()}
        ${
          selected
            ? "border-white shadow-2xl ring-2 ring-white/50 scale-105"
            : "border-white/20 shadow-xl hover:shadow-2xl hover:border-white/40"
        }
        transition-all duration-200 backdrop-blur-sm
      `}
      style={{
        boxShadow: selected
          ? "0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2), 0 0 20px rgba(239, 68, 68, 0.4)"
          : "0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.2)",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="w-3 h-3 bg-white border-2 border-black/50 shadow-lg"
      />

      <div className="flex items-center gap-3">
        <span className="text-2xl">{getIcon()}</span>
        <div className="flex-1">
          <div className="text-white font-semibold">{data.label}</div>
          <div className="text-white/80 text-xs">
            {data.type === "START" ? "Trigger" : data.type.toLowerCase()}
          </div>
        </div>
      </div>

      {data.type !== "START" && (
        <div className="mt-2 flex gap-1 text-xs text-white/70">
          {data.required && (
            <span className="bg-white/20 px-2 py-0.5 rounded border border-white/30">Required</span>
          )}
          {data.retryable && (
            <span className="bg-white/20 px-2 py-0.5 rounded border border-white/30">Retryable</span>
          )}
          {data.continueOnError && (
            <span className="bg-white/20 px-2 py-0.5 rounded border border-white/30">
              Continue on error
            </span>
          )}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        className="w-3 h-3 bg-white border-2 border-black/50 shadow-lg"
      />
    </div>
  );
}
