import { Skeleton } from "@/components/skeleton";

export default function AccountsLoading() {
  return (
    <div>
      <div className="flex items-center gap-2 px-4 pt-4">
        <Skeleton className="h-5 w-5 rounded-full" />
        <Skeleton className="h-3 w-14" />
      </div>
      <div className="space-y-6 px-4 pb-8 pt-6">
        <header className="flex items-center justify-between">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-3.5 w-14" />
        </header>
        <div className="rounded-2xl border border-border bg-surface px-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`flex items-center gap-3 py-3 ${i > 0 ? "border-t border-border" : ""}`}>
              <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
