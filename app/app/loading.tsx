import { Skeleton } from "@/components/skeleton";

// Mirrors app/app/page.tsx's layout (header, balance card, month summary,
// recent transactions, category breakdown) so nothing jumps when it loads.
export default function DashboardLoading() {
  return (
    <div className="space-y-6 px-4 pb-8 pt-6">
      <header className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-28" />
      </header>

      <Skeleton className="h-32 rounded-2xl" />

      <div>
        <Skeleton className="mb-2.5 h-4 w-24" />
        <Skeleton className="h-36 rounded-2xl" />
      </div>

      <div>
        <div className="mb-2.5 flex items-center justify-between">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-14" />
        </div>
        <div className="rounded-2xl border border-border bg-surface px-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`flex items-center gap-3 py-3 ${i > 0 ? "border-t border-border" : ""}`}>
              <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
              <Skeleton className="h-3.5 w-14" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
