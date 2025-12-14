import { InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={`
          w-full px-4 py-2.5
          bg-white/5 backdrop-blur-sm
          border border-white/10
          rounded text-white
          placeholder-white/25
          transition-all duration-150
          hover:bg-white/[0.07] hover:border-white/20
          focus:outline-none focus:bg-white/[0.08] focus:border-annex-500/50 focus:ring-1 focus:ring-annex-500/30
          ${className}
        `}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";

export { Input };
