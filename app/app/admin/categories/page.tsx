import nextDynamic from "next/dynamic";
import { listDefaultCategories } from "@/lib/data/admin-categories";
import { Skeleton } from "@/components/skeleton";

export const dynamic = "force-dynamic";

// Lazy-loaded (4.3.3, perf finding): this is the heaviest interactive piece
// under /app/admin (~340-line CRUD form + list) and, unlike virtually every
// other route in the app (see the various app/app/*/loading.tsx files),
// none of the admin routes have a loading.tsx today - this gives the page
// an equivalent skeleton instead of a blank gap while the client chunk
// hydrates. Note this is about this page's own hydration, not shrinking
// other users' bundles: Next.js already excludes admin-only client
// components from every non-admin route's JS via its own per-route code
// splitting (verified directly in .next's client-reference-manifest output
// - this component's chunk is referenced only by this route, not by e.g.
// the dashboard), so this wasn't shipping to regular users before either.
const DefaultCategoriesManager = nextDynamic(
  () => import("@/components/admin/default-categories-manager").then((mod) => mod.DefaultCategoriesManager),
  { loading: () => <DefaultCategoriesManagerSkeleton /> }
);

export default async function AdminDefaultCategoriesPage() {
  const categories = await listDefaultCategories();

  return <DefaultCategoriesManager categories={categories} />;
}

// Mirrors DefaultCategoriesManager's own outer layout (space-y-6 px-4 pb-8
// pt-5, a short intro line, then a stack of category cards) so swapping the
// real component in doesn't visibly jump.
function DefaultCategoriesManagerSkeleton() {
  return (
    <div className="space-y-6 px-4 pb-8 pt-5">
      <Skeleton className="h-3 w-full max-w-xs" />
      <div className="space-y-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4">
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}
