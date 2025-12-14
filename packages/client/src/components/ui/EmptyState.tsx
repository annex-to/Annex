import { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="text-center py-12 px-6 bg-white/5 backdrop-blur-sm border border-white/10 rounded">
      {icon && (
        <div className="flex justify-center mb-4 text-white/30">
          {icon}
        </div>
      )}
      <p className="text-white/70">{title}</p>
      {description && (
        <p className="text-sm text-white/40 mt-1">{description}</p>
      )}
      {action && (
        <div className="mt-4">{action}</div>
      )}
    </div>
  );
}
