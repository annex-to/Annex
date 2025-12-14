import { useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { createPortal } from "react-dom";
import { PopcornParticles } from "./PopcornParticles";

interface NavButtonProps {
  to: string;
  children: React.ReactNode;
  end?: boolean;
}

export function NavButton({ to, children, end }: NavButtonProps) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const [particleTrigger, setParticleTrigger] = useState(0);
  const [particleOrigin, setParticleOrigin] = useState({ x: 0, y: 0, spread: 60 });

  const handleClick = () => {
    if (linkRef.current && Math.random() < 0.5) {
      const rect = linkRef.current.getBoundingClientRect();
      setParticleOrigin({
        x: rect.left + rect.width / 2,
        y: rect.top, // Spawn from top edge
        spread: rect.width * 0.8,
      });
      setParticleTrigger((prev) => prev + 1);
    }
  };

  return (
    <>
      <NavLink
        ref={linkRef}
        to={to}
        end={end}
        onClick={handleClick}
        className={({ isActive }) =>
          `px-3 py-1.5 rounded text-sm font-medium transition-all duration-150 border ${
            isActive
              ? "bg-annex-500/20 text-annex-400 border-annex-500/30"
              : "text-white/50 border-transparent hover:text-white hover:bg-white/5"
          }`
        }
      >
        {children}
      </NavLink>
      {createPortal(
        <PopcornParticles
          trigger={particleTrigger}
          originX={particleOrigin.x}
          originY={particleOrigin.y}
          spread={particleOrigin.spread}
        />,
        document.body
      )}
    </>
  );
}
