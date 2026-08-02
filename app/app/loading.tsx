import { Skeleton } from "@/components/skeleton";

export default function DashboardLoading() {
  return (
    <div className="space-y-5 px-4 pb-8 pt-6">
      <header className="space-y-2">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-6 w-16" />
      </header>

      <Skeleton className="h-28 rounded-2xl" />

      <div>
        <Skeleton className="mb-2 h-3 w-20" />
        <div className="flex gap-3">
          <Skeleton className="h-24 flex-1 rounded-2xl" />
          <Skeleton className="h-24 flex-1 rounded-2xl" />
        </div>
      </div>

      <Skeleton className="h-32 rounded-2xl" />

      <div>
        <div className="mb-2 flex items-center justify-between">
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
