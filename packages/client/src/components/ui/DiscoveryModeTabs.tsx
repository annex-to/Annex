import { DISCOVERY_MODES, type DiscoveryMode } from "../../hooks/useDiscoverFilters";

interface DiscoveryModeTabsProps {
  mode: DiscoveryMode;
  onModeChange: (mode: DiscoveryMode) => void;
}

export function DiscoveryModeTabs({
  mode,
  onModeChange,
}: DiscoveryModeTabsProps) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-white/10">
      {DISCOVERY_MODES.map((m) => (
        <button
          key={m.value}
          onClick={() => onModeChange(m.value)}
          className={`
            shrink-0 px-4 py-2 text-sm rounded transition-all duration-150
            ${
              mode === m.value
                ? "bg-annex-500/30 text-annex-300 border border-annex-500/50"
                : "bg-white/5 text-white/60 border border-white/10 hover:bg-white/10 hover:text-white/80"
            }
          `}
          title={m.description}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
