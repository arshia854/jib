import { Skeleton } from "@/components/skeleton";

export default function AddTransactionLoading() {
  return (
    <div className="flex h-full flex-col px-4 pb-6 pt-6">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="mt-2 h-3.5 w-56" />
      <div className="mt-6 flex flex-col gap-3">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-12 rounded-2xl" />
      </div>
    </div>
  );
}
