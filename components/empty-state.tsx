import Link from "next/link";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: { href: string; label: string };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border px-4 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface text-muted">{icon}</div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="text-xs text-muted">{description}</p>}
      {action && (
        <Link
          href={action.href}
          className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-primary-darker px-4 py-2 text-xs font-semibold text-white"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
