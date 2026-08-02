import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listCategories } from "@/lib/data/categories";
import { getTransaction } from "@/lib/data/transactions";
import { getDefaultAccount, listAccounts } from "@/lib/data/accounts";
import { AddTransactionForm } from "@/components/transactions/add-transaction-form";
import type { CategoryType } from "@/lib/categories";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ editId?: string }>;
}

export default async function AddTransactionPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { editId } = await searchParams;
  const defaultAccount = await getDefaultAccount(session.userId);
  const [categories, accounts] = await Promise.all([
    listCategories(session.userId),
    listAccounts(session.userId),
  ]);

  if (editId) {
    const transactionId = Number(editId);
    const transaction = Number.isInteger(transactionId) ? await getTransaction(session.userId, transactionId) : null;
    if (!transaction) notFound();

    return (
      <AddTransactionForm
        categories={categories}
        accounts={accounts}
        defaultAccountId={defaultAccount.id}
        editTransaction={{
          id: transaction.id,
          amount: transaction.amount,
          type: transaction.type as CategoryType,
          category: transaction.category.name,
          description: transaction.description ?? "",
          date: transaction.date.toISOString().slice(0, 10),
          accountId: transaction.accountId,
        }}
      />
    );
  }

  return <AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={defaultAccount.id} />;
}
