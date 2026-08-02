import { getAdminOverviewStats } from "@/lib/data/admin-stats";
import { StatTile } from "@/components/admin/stat-tile";
import { UsersIcon, ListIcon, ArrowUpIcon, ChartIcon } from "@/components/icons";
import { formatNumber, formatToman } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const stats = await getAdminOverviewStats();

  return (
    <div className="space-y-6 px-4 pb-8 pt-5">
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="کل کاربران" value={formatNumber(stats.totalUsers)} icon={<UsersIcon className="h-5 w-5" />} />
        <StatTile
          label="کل تراکنش‌ها"
          value={formatNumber(stats.totalTransactions)}
          icon={<ListIcon className="h-5 w-5" />}
        />
        <StatTile
          label="کاربران جدید (۷ روز اخیر)"
          value={formatNumber(stats.newUsers7d)}
          icon={<ArrowUpIcon className="h-5 w-5" />}
        />
        <StatTile
          label="کاربران جدید (۳۰ روز اخیر)"
          value={formatNumber(stats.newUsers30d)}
          icon={<ChartIcon className="h-5 w-5" />}
        />
      </div>

      <div>
        <p className="mb-2 text-xs text-muted">روند حجم تراکنش‌ها (۶ ماه اخیر)</p>
        <div className="rounded-2xl border border-border bg-surface px-4">
          {stats.monthlyTrend.map((point, i) => (
            <div
              key={point.monthKey}
              className={`flex items-center justify-between py-3 ${i > 0 ? "border-t border-border" : ""}`}
            >
              <span className="text-sm font-medium text-foreground">{point.label}</span>
              <span className="text-xs text-muted">{formatNumber(point.transactionCount)} تراکنش</span>
              <span className="text-sm font-semibold tabular-fa text-foreground">
                {formatToman(point.totalAmount)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
