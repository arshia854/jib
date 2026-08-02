import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listTransactions } from "@/lib/data/transactions";
import { listCategories } from "@/lib/data/categories";
import { TransactionFilterBar } from "@/components/transactions/transaction-filter-bar";
import { TransactionListItem } from "@/components/transactions/transaction-list-item";
import { EmptyState } from "@/components/empty-state";
import { ListIcon } from "@/components/icons";
import type { CategoryType } from "@/lib/categories";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ type?: string; categoryId?: string }>;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect("/login");

  const params = await searchParams;
  const type: CategoryType | undefined =
    params.type === "income" || params.type === "expense" ? params.type : undefined;
  const categoryId = params.categoryId ? Number(params.categoryId) : undefined;

  const [transactions, categories] = await Promise.all([
    listTransactions(session.userId, { type, categoryId }),
    listCategories(session.userId),
  ]);

  const hasFilter = Boolean(type) || categoryId !== undefined;

  return (
    <div className="space-y-4 px-4 pb-8 pt-6">
      <header>
        <h1 className="text-lg font-bold text-foreground">تراکنش‌ها</h1>
      </header>

      <Suspense fallback={<div className="h-10" />}>
        <TransactionFilterBar categories={categories} />
      </Suspense>

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
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
