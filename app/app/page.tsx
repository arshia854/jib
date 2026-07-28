import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/data/dashboard";
import { BalanceCard } from "@/components/dashboard/balance-card";
import { StatCard } from "@/components/dashboard/stat-card";
import { CategoryBreakdown } from "@/components/dashboard/category-breakdown";
import { TransactionRow } from "@/components/transactions/transaction-row";
import { LogoutButton } from "@/components/layout/logout-button";
import { ArrowUpIcon, ArrowDownIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const data = await getDashboardData(user.id);

  return (
    <div className="space-y-5 px-4 pb-8 pt-6">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted">خوش اومدی{user.name ? `، ${user.name}` : ""}</p>
          <h1 className="text-xl font-bold text-foreground">جیب</h1>
        </div>
        <LogoutButton />
      </header>

      <BalanceCard balance={data.totalBalance} />

      <div>
        <p className="mb-2 text-xs text-muted">خلاصه {data.monthLabel}</p>
        <div className="flex gap-3">
          <StatCard
            label="درآمد"
            amount={data.monthIncome}
            tone="success"
            icon={<ArrowUpIcon className="h-5 w-5" />}
          />
          <StatCard
            label="هزینه"
            amount={data.monthExpense}
            tone="warning"
            icon={<ArrowDownIcon className="h-5 w-5" />}
          />
        </div>
      </div>

      <CategoryBreakdown segments={data.categoryBreakdown} totalExpense={data.monthExpense} />

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">تراکنش‌های اخیر</h2>
          <Link href="/app/transactions" className="text-xs font-medium text-accent">
            مشاهده همه
          </Link>
        </div>
        <div className="rounded-2xl border border-border bg-surface px-4">
          {data.recentTransactions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">هنوز تراکنشی ثبت نشده است.</p>
          ) : (
            data.recentTransactions.map((t, i) => (
              <div key={t.id} className={i > 0 ? "border-t border-border" : ""}>
                <TransactionRow
                  description={t.description}
                  rawInput={t.rawInput}
                  date={t.date}
                  amount={t.amount}
                  type={t.type}
                  category={t.category}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
