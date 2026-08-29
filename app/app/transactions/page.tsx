import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listTransactions } from "@/lib/data/transactions";
import { listCategories } from "@/lib/data/categories";
import { TransactionFilterBar } from "@/components/transactions/transaction-filter-bar";
import { TransactionListItem } from "@/components/transactions/transaction-list-item";
import { PendingTransactionList } from "@/components/transactions/pending-transaction-list";
import { EnrichmentPoller } from "@/components/transactions/enrichment-poller";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { EmptyState } from "@/components/empty-state";
import { ListIcon } from "@/components/icons";
import type { CategoryType } from "@/lib/categories";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ type?: string; categoryId?: string; page?: string }>;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect("/login");

  const params = await searchParams;
  const type: CategoryType | undefined =
    params.type === "income" || params.type === "expense" ? params.type : undefined;
  const categoryId = params.categoryId ? Number(params.categoryId) : undefined;
  // Same defensive parse-or-fallback used for `page` in
  // app/app/admin/users/page.tsx.
  const requestedPage = Number(params.page);
  const requestedPageValid = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const [result, categories] = await Promise.all([
    listTransactions(session.userId, { type, categoryId }, requestedPageValid),
    listCategories(session.userId),
  ]);

  // A URL pointing past the last page (most reachable by deleting the last
  // transaction(s) while on the last page - see transaction-list-item.tsx's
  // handleDelete, which does router.refresh() against this same URL) would
  // otherwise render as a confusing "no transactions" empty state instead of
  // the real last page - land back on the real last page instead. totalPages
  // is always >= 1, so this never fires for requestedPageValid === 1.
  if (requestedPageValid > result.totalPages) {
    const fallbackParams = new URLSearchParams();
    if (params.type) fallbackParams.set("type", params.type);
    if (params.categoryId) fallbackParams.set("categoryId", params.categoryId);
    fallbackParams.set("page", String(result.totalPages));
    redirect(`/app/transactions?${fallbackParams.toString()}`);
  }

  const { transactions, page, totalPages } = result;
  const hasFilter = Boolean(type) || categoryId !== undefined;
  const hasPendingEnrichment = transactions.some((t) => t.enrichmentStatus === "pending");

  return (
    <div className="space-y-4 px-4 pb-8 pt-6">
      <EnrichmentPoller hasPending={hasPendingEnrichment} />
      <header>
        <h1 className="text-lg font-bold text-foreground">تراکنش‌ها</h1>
      </header>

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
            <Link href="/app/transactions" className="mt-2 inline-block text-xs font-medium text-accent">
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
            basePath="/app/transactions"
            page={page}
            totalPages={totalPages}
            queryParams={{ type: params.type, categoryId: params.categoryId }}
          />
        </>
      )}
    </div>
  );
}
