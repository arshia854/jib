import Link from "next/link";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  // `href` for a CTA that navigates; `onClick` for one that opens something
  // in place (e.g. assets-manager.tsx's add-asset sheet) - only usable from
  // a client component, since a function can't cross the server boundary.
  action?: { label: string } & ({ href: string } | { onClick: () => void });
}

const ACTION_CLASS =
  "mt-2 inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-on-primary";

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border px-4 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface text-muted">{icon}</div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="text-xs text-muted">{description}</p>}
      {action &&
        ("href" in action ? (
          <Link href={action.href} className={ACTION_CLASS}>
            {action.label}
          </Link>
        ) : (
          <button type="button" onClick={action.onClick} className={ACTION_CLASS}>
            {action.label}
          </button>
        ))}
    </div>
  );
}
