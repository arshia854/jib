import Link from "next/link";
import nextDynamic from "next/dynamic";
import { notFound } from "next/navigation";
import { getUserDetailForAdmin, AdminUserNotFoundError } from "@/lib/data/admin-users";
import { formatJalaaliDate, formatNumber } from "@/lib/format";
import { BackIcon } from "@/components/icons";
import { Skeleton } from "@/components/skeleton";

export const dynamic = "force-dynamic";

// Lazy-loaded (4.3.3, perf finding): a rarely-used, destructive-action
// panel (block/unblock, delete user) - deferring it means the user's own
// summary card above renders without waiting on this chunk too. As with
// the default-categories-manager (see that page for the fuller note), this
// route already has no loading.tsx of its own, and this component's chunk
// was already excluded from non-admin routes' bundles by Next's per-route
// code splitting regardless of this wrapping.
const UserDangerZone = nextDynamic(
  () => import("@/components/admin/user-danger-zone").then((mod) => mod.UserDangerZone),
  {
    loading: () => (
      <div className="space-y-3 rounded-2xl border border-border bg-surface p-4">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-9 w-full rounded-xl" />
        <Skeleton className="h-9 w-full rounded-xl" />
      </div>
    ),
  }
);

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AdminUserDetailPage({ params }: PageProps) {
  const { id } = await params;
  const userId = Number(id);
  if (!Number.isInteger(userId)) notFound();

  let user;
  try {
    user = await getUserDetailForAdmin(userId);
  } catch (error) {
    if (error instanceof AdminUserNotFoundError) notFound();
    throw error;
  }

  return (
    <div className="space-y-5 px-4 pb-8 pt-5">
      <Link href="/app/admin/users" className="inline-flex items-center gap-1 text-xs text-muted">
        <BackIcon className="h-4 w-4" />
        بازگشت به کاربران
      </Link>

      <section className="rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-bold text-primary-dark">
            {(user.name ?? user.phoneNumber ?? user.email ?? "ک").charAt(0)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">{user.name ?? "بدون‌نام"}</p>
            <p dir="ltr" className="text-left text-xs text-muted">
              {user.phoneNumber ?? user.email ?? "—"}
            </p>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
          <DetailRow label="نقش" value={user.role === "admin" ? "مدیر" : "کاربر عادی"} />
          <DetailRow label="وضعیت" value={user.blockedAt ? "مسدود" : "فعال"} />
          <DetailRow label="تاریخ ثبت‌نام" value={formatJalaaliDate(user.createdAt)} />
          <DetailRow label="تراکنش‌ها" value={formatNumber(user.transactionCount)} />
          <DetailRow label="حساب‌ها" value={formatNumber(user.accountCount)} />
          <DetailRow label="دسته‌بندی‌ها" value={formatNumber(user.categoryCount)} />
        </dl>
      </section>

      <UserDangerZone userId={user.id} blocked={Boolean(user.blockedAt)} />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-foreground">{value}</dd>
    </div>
  );
}
