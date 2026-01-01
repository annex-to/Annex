import { ReactNode, useEffect, useRef, useState } from "react";

interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  children: ReactNode;
}

export function ContextMenu({ items, children }: ContextMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setPosition({ x: e.clientX, y: e.clientY });
    setIsOpen(true);
  };

  return (
    <div onContextMenu={handleContextMenu}>
      {children}
      {isOpen && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-black/95 border border-white/20 rounded shadow-lg backdrop-blur-sm min-w-[180px]"
          style={{ left: position.x, top: position.y }}
        >
          {items.map((item, index) => (
            <button
              key={index}
              onClick={() => {
                if (!item.disabled) {
                  item.onClick();
                  setIsOpen(false);
                }
              }}
              disabled={item.disabled}
              className={`
                w-full text-left px-4 py-2 text-sm
                transition-colors duration-150
                ${
                  item.disabled
                    ? "text-white/30 cursor-not-allowed"
                    : item.destructive
                      ? "text-red-400 hover:bg-red-500/10"
                      : "text-white/80 hover:bg-white/5"
                }
                ${index === 0 ? "rounded-t" : ""}
                ${index === items.length - 1 ? "rounded-b" : "border-b border-white/10"}
              `}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
