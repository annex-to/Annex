import { QUALITY_TIERS, type QualityTier } from "../../hooks/useDiscoverFilters";

interface QualityTierSelectorProps {
  tier: QualityTier;
  onTierChange: (tier: QualityTier) => void;
}

export function QualityTierSelector({
  tier,
  onTierChange,
}: QualityTierSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-white/50">Quality:</span>
      <div className="flex items-center gap-1">
        {QUALITY_TIERS.map((t) => (
          <button
            key={t.value}
            onClick={() => onTierChange(t.value)}
            className={`
              px-2.5 py-1 text-xs rounded transition-all duration-150
              ${
                tier === t.value
                  ? "bg-annex-500/30 text-annex-300 border border-annex-500/50"
                  : "bg-white/5 text-white/50 border border-white/10 hover:bg-white/10 hover:text-white/70"
              }
            `}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
