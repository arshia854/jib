import { Skeleton } from "@/components/skeleton";

export default function TransactionsLoading() {
  return (
    <div className="space-y-4 px-4 pb-8 pt-6">
      <header>
        <Skeleton className="h-5 w-24" />
      </header>

      <div className="flex gap-2">
        <Skeleton className="h-9 w-32 rounded-xl" />
        <Skeleton className="h-9 w-32 rounded-xl" />
      </div>

      <div className="rounded-2xl border border-border bg-surface px-4">
        {[0, 1, 2, 3, 4].map((i) => (
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
  );
}
