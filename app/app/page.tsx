import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/data/dashboard";
import { IncomeReactionBanner } from "@/components/dashboard/income-reaction-banner";
import { BalanceCard } from "@/components/dashboard/balance-card";
import { MonthSummaryCard } from "@/components/dashboard/month-summary-card";
import { CategoryBreakdown } from "@/components/dashboard/category-breakdown";
import { TransactionRow } from "@/components/transactions/transaction-row";
import { TransferRow } from "@/components/transactions/transfer-row";
import { EnrichmentPoller } from "@/components/transactions/enrichment-poller";
import { BackIcon, ListIcon } from "@/components/icons";
import { EmptyState } from "@/components/empty-state";
import { groupTransferPairs } from "@/lib/transactions/group-transfer-pairs";

export const dynamic = "force-dynamic";

// e.g. "یکشنبه ۵ مهر" - fa-IR's default calendar is already the Jalali one.
const todayFormatter = new Intl.DateTimeFormat("fa-IR", { weekday: "long", day: "numeric", month: "long" });

// One heading style for every section on the page (it used to be three:
// a muted caption, a heading inside its card, and one above its card).
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {action && (
          <Link
            href={action.href}
            className="-my-1 -me-2 flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs font-medium text-primary-soft"
          >
            {action.label}
            <BackIcon className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const data = await getDashboardData(user.id);
  const pendingEnrichmentIds = data.recentTransactions
    .filter((t) => t.enrichmentStatus === "pending")
    .map((t) => t.id);
  // Phase A3 (docs/roadmap-status.md savings roadmap): collapses any
  // transferGroupId pair within this already-fetched top-5 slice into one
  // row - see lib/transactions/group-transfer-pairs.ts's own comment for
  // why this runs here (list-assembly layer) rather than inside
  // getDashboardData() itself or inside TransactionRow.
  const recentRows = groupTransferPairs(data.recentTransactions);
  // recentTransactions is the all-time top 5, so empty means the user has
  // never logged anything - every section below would just be zeros.
  const hasAnyTransactions = data.recentTransactions.length > 0;

  return (
    <div className="space-y-6 px-4 pb-8 pt-6">
      <EnrichmentPoller pendingIds={pendingEnrichmentIds} />
      <header>
        <p className="text-xs text-muted">{todayFormatter.format(new Date())}</p>
        <h1 className="mt-0.5 text-xl font-bold text-foreground">سلام{user.name ? `، ${user.name}` : "!"}</h1>
      </header>

      {data.incomeReaction && (
        <IncomeReactionBanner
          incomeTransactionId={data.incomeReaction.incomeTransactionId}
          incomeAmount={data.incomeReaction.incomeAmount}
          items={data.incomeReaction.items}
        />
      )}

      <BalanceCard
        balance={data.totalBalance}
        savingsBalance={data.hasSavingsAccount ? data.savingsBalance : undefined}
        assetEquivalent={
          data.balanceInGoldGrams !== null && data.balanceInUsd !== null
            ? { goldGrams: data.balanceInGoldGrams, usd: data.balanceInUsd }
            : undefined
        }
      />

      {!hasAnyTransactions ? (
        <EmptyState
          icon={<ListIcon className="h-6 w-6" />}
          title="هنوز تراکنشی ثبت نکردی"
          description="اولین درآمد یا هزینه‌ات رو ثبت کن تا خلاصه‌ی ماهت اینجا نمایش داده بشه."
          action={{ href: "/app/add", label: "افزودن تراکنش" }}
        />
      ) : (
        <>
          <Section title={`خلاصه‌ی ${data.monthLabel}`}>
            <MonthSummaryCard income={data.monthIncome} expense={data.monthExpense} />
          </Section>

          {/* Recent transactions sit above the category breakdown: after
              logging something the user lands back here, and their new row
              (with its AI-enrichment status) is what they're looking for. */}
          <Section title="تراکنش‌های اخیر" action={{ href: "/app/dashboard?tab=transactions", label: "مشاهده همه" }}>
            <div className="rounded-2xl border border-border bg-surface px-4">
              {recentRows.map((row, i) => (
                <div
                  key={row.kind === "transfer" ? row.transferGroupId : row.id}
                  className={i > 0 ? "border-t border-border" : ""}
                >
                  {row.kind === "transfer" ? (
                    <TransferRow
                      fromAccountName={row.fromAccount.name}
                      toAccountName={row.toAccount.name}
                      amount={row.amount}
                      date={row.date}
                    />
                  ) : (
                    <TransactionRow
                      description={row.description}
                      rawInput={row.rawInput}
                      date={row.date}
                      amount={row.amount}
                      type={row.type}
                      category={row.category}
                      enrichmentStatus={row.enrichmentStatus}
                    />
                  )}
                </div>
              ))}
            </div>
          </Section>

          <Section title="هزینه‌ها به تفکیک دسته‌بندی" action={{ href: "/app/reports", label: "گزارش‌ها" }}>
            <CategoryBreakdown segments={data.categoryBreakdown} totalExpense={data.monthExpense} />
          </Section>
        </>
      )}
    </div>
  );
}
