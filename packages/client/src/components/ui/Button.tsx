import { ButtonHTMLAttributes, forwardRef, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PopcornParticles } from "./PopcornParticles";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  popcorn?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-annex-500/20 text-annex-400 hover:bg-annex-500/30 hover:text-white active:bg-annex-500/15 border border-annex-500/30",
  secondary:
    "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white active:bg-white/5 border border-white/10",
  ghost:
    "bg-transparent text-white/60 hover:bg-white/5 hover:text-white",
  danger:
    "bg-red-500/20 text-red-400 hover:bg-red-500/30 hover:text-white active:bg-red-500/15 border border-red-500/30",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
  lg: "px-4 py-2",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", popcorn = true, className = "", children, onClick, ...props }, ref) => {
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [particleTrigger, setParticleTrigger] = useState(0);
    const [particleOrigin, setParticleOrigin] = useState({ x: 0, y: 0, spread: 60 });

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (popcorn && buttonRef.current && Math.random() < 0.5) {
        const rect = buttonRef.current.getBoundingClientRect();
        setParticleOrigin({
          x: rect.left + rect.width / 2,
          y: rect.top, // Spawn from top edge
          spread: rect.width * 0.8, // Spread across most of button width
        });
        setParticleTrigger((prev) => prev + 1);
      }
      onClick?.(e);
    };

    return (
      <>
        <button
          ref={(node) => {
            // Handle both refs
            (buttonRef as React.MutableRefObject<HTMLButtonElement | null>).current = node;
            if (typeof ref === "function") {
              ref(node);
            } else if (ref) {
              ref.current = node;
            }
          }}
          className={`
            inline-flex items-center justify-center
            font-medium rounded
            transition-all duration-150
            focus:outline-none focus:ring-2 focus:ring-annex-500/50 focus:ring-offset-2 focus:ring-offset-black
            disabled:opacity-50 disabled:cursor-not-allowed
            ${variantStyles[variant]}
            ${sizeStyles[size]}
            ${className}
          `}
          onClick={handleClick}
          {...props}
        >
          {children}
        </button>
        {popcorn && createPortal(
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
);

Button.displayName = "Button";

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize };
