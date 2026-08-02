import { listUsersForAdmin } from "@/lib/data/admin-users";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { UserRow } from "@/components/admin/user-row";
import { EmptyState } from "@/components/empty-state";
import { UsersIcon } from "@/components/icons";
import { formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function AdminUsersPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const requestedPage = Number(params.page);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const result = await listUsersForAdmin(page);

  return (
    <div className="space-y-4 px-4 pb-8 pt-5">
      <h2 className="text-sm font-semibold text-foreground">کاربران ({formatNumber(result.total)})</h2>

      {result.items.length === 0 ? (
        <EmptyState icon={<UsersIcon className="h-6 w-6" />} title="کاربری یافت نشد." />
      ) : (
        <div className="rounded-2xl border border-border bg-surface px-4">
          {result.items.map((user, i) => (
            <div key={user.id} className={i > 0 ? "border-t border-border" : ""}>
              <UserRow user={user} />
            </div>
          ))}
        </div>
      )}

      <PaginationControls basePath="/app/admin/users" page={result.page} totalPages={result.totalPages} />
    </div>
  );
}
