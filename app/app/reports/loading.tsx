import { Skeleton } from "@/components/skeleton";

export default function ReportsLoading() {
  return (
    <div className="space-y-4 px-4 pb-8 pt-6">
      <header>
        <Skeleton className="h-5 w-20" />
      </header>

      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-12 rounded-full" />
            </div>
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-2 min-w-0 flex-1 rounded-full" />
                <Skeleton className="h-3 w-12 shrink-0" />
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-2 min-w-0 flex-1 rounded-full" />
                <Skeleton className="h-3 w-12 shrink-0" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
