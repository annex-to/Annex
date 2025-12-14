import { useCallback, useRef, useEffect, useState } from "react";

interface RangeSliderProps {
  min: number;
  max: number;
  step?: number;
  value: [number, number];
  onChange: (value: [number, number]) => void;
  formatValue?: (value: number) => string;
  label?: string;
  color?: string;
  disabled?: boolean;
}

export function RangeSlider({
  min,
  max,
  step = 1,
  value,
  onChange,
  formatValue = (v) => v.toString(),
  label,
  color = "bg-annex-500",
  disabled = false,
}: RangeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState<"min" | "max" | null>(null);
  const [localValue, setLocalValue] = useState(value);

  // Sync local value with prop
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const getPercentage = useCallback(
    (val: number) => ((val - min) / (max - min)) * 100,
    [min, max]
  );

  const getValueFromPosition = useCallback(
    (clientX: number) => {
      if (!trackRef.current) return min;
      const rect = trackRef.current.getBoundingClientRect();
      const percentage = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const rawValue = min + percentage * (max - min);
      // Snap to step
      const steppedValue = Math.round(rawValue / step) * step;
      return Math.max(min, Math.min(max, steppedValue));
    },
    [min, max, step]
  );

  const handleMouseDown = useCallback(
    (thumb: "min" | "max") => (e: React.MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      setIsDragging(thumb);
    },
    [disabled]
  );

  const handleTouchStart = useCallback(
    (thumb: "min" | "max") => (_e: React.TouchEvent) => {
      if (disabled) return;
      setIsDragging(thumb);
    },
    [disabled]
  );

  // Handle mouse/touch move
  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (clientX: number) => {
      const newValue = getValueFromPosition(clientX);
      setLocalValue((prev) => {
        if (isDragging === "min") {
          // Min thumb can't go past max thumb
          const clampedMin = Math.min(newValue, prev[1]);
          return [clampedMin, prev[1]];
        } else {
          // Max thumb can't go before min thumb
          const clampedMax = Math.max(newValue, prev[0]);
          return [prev[0], clampedMax];
        }
      });
    };

    const handleMouseMove = (e: MouseEvent) => handleMove(e.clientX);
    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        handleMove(e.touches[0].clientX);
      }
    };

    const handleEnd = () => {
      setIsDragging(null);
      // Commit the change
      onChange(localValue);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleEnd);
    document.addEventListener("touchmove", handleTouchMove);
    document.addEventListener("touchend", handleEnd);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleEnd);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleEnd);
    };
  }, [isDragging, getValueFromPosition, localValue, onChange]);

  const minPercent = getPercentage(localValue[0]);
  const maxPercent = getPercentage(localValue[1]);

  // Check if filter is active (not at default min/max)
  const isActive = localValue[0] > min || localValue[1] < max;

  return (
    <div className={`space-y-2 ${disabled ? "opacity-50" : ""}`}>
      {/* Label and values */}
      <div className="flex items-center justify-between">
        {label && (
          <span className={`text-xs font-medium ${isActive ? "text-white/90" : "text-white/50"}`}>
            {label}
          </span>
        )}
        <span className={`text-xs tabular-nums ${isActive ? "text-white/80" : "text-white/40"}`}>
          {formatValue(localValue[0])} — {formatValue(localValue[1])}
        </span>
      </div>

      {/* Slider track */}
      <div
        ref={trackRef}
        className="relative h-6 flex items-center cursor-pointer"
        onClick={(e) => {
          if (disabled) return;
          const clickValue = getValueFromPosition(e.clientX);
          // Move the closest thumb
          const distToMin = Math.abs(clickValue - localValue[0]);
          const distToMax = Math.abs(clickValue - localValue[1]);
          if (distToMin <= distToMax) {
            const newMin = Math.min(clickValue, localValue[1]);
            setLocalValue([newMin, localValue[1]]);
            onChange([newMin, localValue[1]]);
          } else {
            const newMax = Math.max(clickValue, localValue[0]);
            setLocalValue([localValue[0], newMax]);
            onChange([localValue[0], newMax]);
          }
        }}
      >
        {/* Background track */}
        <div className="absolute inset-x-0 h-1 bg-white/10 rounded-full" />

        {/* Active range highlight */}
        <div
          className={`absolute h-1 rounded-full transition-colors ${
            isActive ? color : "bg-white/20"
          }`}
          style={{
            left: `${minPercent}%`,
            width: `${maxPercent - minPercent}%`,
          }}
        />

        {/* Min thumb */}
        <div
          className={`absolute w-4 h-4 -ml-2 rounded-full border-2 transition-all cursor-grab active:cursor-grabbing ${
            isDragging === "min"
              ? `${color} border-white scale-110`
              : isActive
              ? `${color} border-white/80 hover:scale-110`
              : "bg-white/20 border-white/40 hover:bg-white/30"
          }`}
          style={{ left: `${minPercent}%` }}
          onMouseDown={handleMouseDown("min")}
          onTouchStart={handleTouchStart("min")}
        />

        {/* Max thumb */}
        <div
          className={`absolute w-4 h-4 -ml-2 rounded-full border-2 transition-all cursor-grab active:cursor-grabbing ${
            isDragging === "max"
              ? `${color} border-white scale-110`
              : isActive
              ? `${color} border-white/80 hover:scale-110`
              : "bg-white/20 border-white/40 hover:bg-white/30"
          }`}
          style={{ left: `${maxPercent}%` }}
          onMouseDown={handleMouseDown("max")}
          onTouchStart={handleTouchStart("max")}
        />
      </div>
    </div>
  );
}
