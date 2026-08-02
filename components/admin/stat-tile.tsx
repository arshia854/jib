import type { ReactNode } from "react";

interface StatTileProps {
  label: string;
  value: string;
  icon: ReactNode;
}

export function StatTile({ label, value, icon }: StatTileProps) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary-dark">
        {icon}
      </div>
      <p className="mt-3 text-xs text-muted">{label}</p>
      <p className="mt-1 text-base font-semibold tabular-fa text-foreground">{value}</p>
    </div>
  );
}
