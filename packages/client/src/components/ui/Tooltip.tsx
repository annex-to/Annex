import { useState, useRef, useLayoutEffect, ReactNode, useCallback } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: string;
  children: ReactNode;
  position?: "top" | "bottom";
}

export function Tooltip({ content, children, position = "top" }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  // Use callback ref to position tooltip after it renders
  const setTooltipRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && triggerRef.current) {
        const triggerRect = triggerRef.current.getBoundingClientRect();
        const tooltipRect = node.getBoundingClientRect();

        // Center horizontally
        let left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;

        // Keep tooltip within viewport
        if (left < 8) left = 8;
        if (left + tooltipRect.width > window.innerWidth - 8) {
          left = window.innerWidth - tooltipRect.width - 8;
        }

        let top: number;
        if (position === "top") {
          top = triggerRect.top - tooltipRect.height - 8;
        } else {
          top = triggerRect.bottom + 8;
        }

        setCoords({ top, left });
      }
    },
    [position]
  );

  // Reset coords when hidden
  useLayoutEffect(() => {
    if (!isVisible) {
      setCoords(null);
    }
  }, [isVisible]);

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
            ref={setTooltipRef}
            style={{
              position: "fixed",
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              visibility: coords ? "visible" : "hidden",
            }}
            className="z-[9999] px-2.5 py-1.5 text-xs font-medium text-white bg-black/90 border border-white/20 rounded shadow-lg whitespace-nowrap pointer-events-none"
          >
            {content}
          </div>,
          document.body
        )}
    </div>
  );
}
