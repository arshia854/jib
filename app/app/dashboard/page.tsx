import { Suspense } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getActivityHeatmap } from "@/lib/data/activity-heatmap";
import { listTransactions } from "@/lib/data/transactions";
import { listCategories } from "@/lib/data/categories";
import { listAssetsWithValue } from "@/lib/data/assets";
import { listGoalsWithFeasibility } from "@/lib/data/goals";
import { ActivityHeatmap } from "@/components/reports/ActivityHeatmap";
import { TransactionFilterBar } from "@/components/transactions/transaction-filter-bar";
import { TransactionListItem } from "@/components/transactions/transaction-list-item";
import { PendingTransactionList } from "@/components/transactions/pending-transaction-list";
import { EnrichmentPoller } from "@/components/transactions/enrichment-poller";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { AssetsManager } from "@/components/assets/assets-manager";
import { GoalsManager } from "@/components/goals/goals-manager";
import { EmptyState } from "@/components/empty-state";
import { ListIcon, ChartIcon, WalletIcon, TargetIcon } from "@/components/icons";
import type { CategoryType } from "@/lib/categories";

export const dynamic = "force-dynamic";

// Consolidates Transactions/Assets/Goals (each previously its own route -
// see app/app/transactions/page.tsx and app/app/settings/assets/page.tsx,
// both now thin redirects here) under one page, with the Activity Heatmap
// (moved out of app/app/reports/page.tsx) always visible above the tabs.
type DashboardTab = "transactions" | "assets" | "goals";

const TABS: { value: DashboardTab; label: string; Icon: typeof ListIcon }[] = [
  { value: "transactions", label: "تراکنش‌ها", Icon: ListIcon },
  { value: "assets", label: "دارایی‌ها", Icon: WalletIcon },
  { value: "goals", label: "هدف‌ها", Icon: TargetIcon },
];

function parseTab(tab: string | undefined): DashboardTab {
  return tab === "assets" || tab === "goals" ? tab : "transactions";
}

interface PageProps {
  searchParams: Promise<{ tab?: string; type?: string; categoryId?: string; page?: string }>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect("/login");

  const params = await searchParams;
  const tab = parseTab(params.tab);

  // Always visible, above every tab (see this task's own layout spec) -
  // fetched on every render regardless of `tab`, same as the tab-specific
  // fetch below fetching only what its own branch needs.
  const heatmap = await getActivityHeatmap(session.userId);

  let content: ReactNode;
  if (tab === "assets") {
    const summary = await listAssetsWithValue(session.userId);
    content = <AssetsManager summary={summary} />;
  } else if (tab === "goals") {
    const goals = await listGoalsWithFeasibility(session.userId);
    content = <GoalsManager goals={goals} />;
  } else {
    // Moved from app/app/transactions/page.tsx verbatim (same filter/pagination
    // behavior) - only basePath/queryParams below changed, to keep `?tab=`
    // alongside `type`/`categoryId`/`page` rather than dropping it.
    const type: CategoryType | undefined =
      params.type === "income" || params.type === "expense" ? params.type : undefined;
    const categoryId = params.categoryId ? Number(params.categoryId) : undefined;
    const requestedPage = Number(params.page);
    const requestedPageValid = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

    const [result, categories] = await Promise.all([
      listTransactions(session.userId, { type, categoryId }, requestedPageValid),
      listCategories(session.userId),
    ]);

    if (requestedPageValid > result.totalPages) {
      const fallbackParams = new URLSearchParams();
      fallbackParams.set("tab", "transactions");
      if (params.type) fallbackParams.set("type", params.type);
      if (params.categoryId) fallbackParams.set("categoryId", params.categoryId);
      fallbackParams.set("page", String(result.totalPages));
      redirect(`/app/dashboard?${fallbackParams.toString()}`);
    }

    const { transactions, page, totalPages } = result;
    const hasFilter = Boolean(type) || categoryId !== undefined;
    const hasPendingEnrichment = transactions.some((t) => t.enrichmentStatus === "pending");

    content = (
      <div className="space-y-4">
        <EnrichmentPoller hasPending={hasPendingEnrichment} />

        <Suspense fallback={<div className="h-10" />}>
          <TransactionFilterBar categories={categories} />
        </Suspense>

        {/* Locally-queued transactions not yet confirmed by the server (see
            lib/offline/transaction-queue.ts) - rendered above the confirmed
            list, independent of it, so a pending item is visible even when
            `transactions` is otherwise empty. */}
        <PendingTransactionList categories={categories} />

        {transactions.length === 0 ? (
          hasFilter ? (
            <div className="rounded-2xl border border-border bg-surface px-4 py-8 text-center">
              <p className="text-sm text-muted">تراکنشی با این فیلتر یافت نشد.</p>
              <Link href="/app/dashboard?tab=transactions" className="mt-2 inline-block text-xs font-medium text-accent">
                حذف فیلترها
              </Link>
            </div>
          ) : (
            <EmptyState
              icon={<ListIcon className="h-6 w-6" />}
              title="هنوز تراکنشی ثبت نکرده‌اید"
              description="اولین تراکنش خود را ثبت کنید تا اینجا نمایش داده شود."
              action={{ href: "/app/add", label: "افزودن تراکنش" }}
            />
          )
        ) : (
          <>
            <div className="rounded-2xl border border-border bg-surface px-4">
              {transactions.map((t, i) => (
                <div key={t.id} className={i > 0 ? "border-t border-border" : ""}>
                  <TransactionListItem
                    id={t.id}
                    description={t.description}
                    rawInput={t.rawInput}
                    date={t.date}
                    amount={t.amount}
                    type={t.type}
                    category={t.category}
                    enrichmentStatus={t.enrichmentStatus}
                  />
                </div>
              ))}
            </div>
            <PaginationControls
              basePath="/app/dashboard"
              page={page}
              totalPages={totalPages}
              queryParams={{ tab: "transactions", type: params.type, categoryId: params.categoryId }}
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 px-4 pb-8 pt-6">
      <header>
        <h1 className="text-lg font-bold text-foreground">داشبورد</h1>
      </header>

      {heatmap.activeDays === 0 ? (
        <EmptyState
          icon={<ChartIcon className="h-6 w-6" />}
          title="هنوز فعالیتی برای نمایش نیست"
          description="با ثبت اولین تراکنش، نقشه فعالیت روزانه شما اینجا نمایش داده می‌شود."
          action={{ href: "/app/add", label: "افزودن تراکنش" }}
        />
      ) : (
        <ActivityHeatmap heatmap={heatmap} />
      )}

      <nav className="grid grid-cols-3 gap-2">
        {TABS.map(({ value, label, Icon }) => {
          const active = value === tab;
          const href = value === "transactions" ? "/app/dashboard" : `/app/dashboard?tab=${value}`;
          return (
            <Link
              key={value}
              href={href}
              className={`flex flex-col items-center gap-2 rounded-2xl border p-3 text-center transition-colors ${
                active ? "border-primary bg-primary-bg" : "border-border bg-surface"
              }`}
            >
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-full ${
                  active ? "bg-primary text-on-primary" : "bg-background text-muted"
                }`}
              >
                <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.5} />
              </span>
              <span className={`text-xs font-medium ${active ? "text-foreground" : "text-muted"}`}>{label}</span>
            </Link>
          );
        })}
      </nav>

      {content}
    </div>
  );
}
