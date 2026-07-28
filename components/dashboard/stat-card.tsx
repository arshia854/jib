import type { ReactNode } from "react";
import { formatToman } from "@/lib/format";

interface StatCardProps {
  label: string;
  amount: number;
  tone: "success" | "warning";
  icon: ReactNode;
}

export function StatCard({ label, amount, tone, icon }: StatCardProps) {
  const toneClasses = tone === "success" ? "bg-success/10 text-success" : "bg-warning/10 text-warning";
  return (
    <div className="flex-1 rounded-2xl border border-border bg-surface p-4">
      <div className={`flex h-9 w-9 items-center justify-center rounded-full ${toneClasses}`}>{icon}</div>
      <p className="mt-3 text-xs text-muted">{label}</p>
      <p className="mt-1 text-base font-semibold tabular-fa text-foreground">{formatToman(amount)}</p>
    </div>
  );
}
