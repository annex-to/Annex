import { LabelHTMLAttributes } from "react";

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  hint?: string;
}

export function Label({ className = "", children, hint, ...props }: LabelProps) {
  return (
    <div className="mb-2">
      <label
        className={`block text-sm font-medium text-white/80 ${className}`}
        {...props}
      >
        {children}
      </label>
      {hint && (
        <p className="text-xs text-white/40 mt-0.5">{hint}</p>
      )}
    </div>
  );
}
