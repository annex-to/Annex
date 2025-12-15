import { useState, useRef, useEffect, ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: string;
  children: ReactNode;
  position?: "top" | "bottom";
}

export function Tooltip({ content, children, position = "top" }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isVisible && triggerRef.current && tooltipRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const tooltipRect = tooltipRef.current.getBoundingClientRect();

      // Center horizontally
      let left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;

      // Keep tooltip within viewport
      if (left < 8) left = 8;
      if (left + tooltipRect.width > window.innerWidth - 8) {
        left = window.innerWidth - tooltipRect.width - 8;
      }

      const style: React.CSSProperties = {
        left: `${left}px`,
        position: "fixed",
      };

      if (position === "top") {
        style.top = `${triggerRect.top - tooltipRect.height - 8}px`;
      } else {
        style.top = `${triggerRect.bottom + 8}px`;
      }

      setTooltipStyle(style);
    }
  }, [isVisible, position]);

  return (
    <div
      ref={triggerRef}
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
      className="inline-block"
    >
      {children}
      {isVisible &&
        createPortal(
          <div
            ref={tooltipRef}
            style={tooltipStyle}
            className="z-[9999] px-2.5 py-1.5 text-xs font-medium text-white bg-black/90 border border-white/20 rounded shadow-lg whitespace-nowrap pointer-events-none"
          >
            {content}
          </div>,
          document.body
        )}
    </div>
  );
}
