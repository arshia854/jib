import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listCategories } from "@/lib/data/categories";
import { getTransaction } from "@/lib/data/transactions";
import { getDefaultAccount, listAccounts } from "@/lib/data/accounts";
import { AddTransactionForm } from "@/components/transactions/add-transaction-form";
import type { CategoryType } from "@/lib/categories";
import type { ParsedTransaction } from "@/lib/ai/parse-transaction";

export const dynamic = "force-dynamic";

interface AddPageSearchParams {
  editId?: string;
  fromSuggestion?: string;
  amount?: string;
  type?: string;
  category?: string;
  description?: string;
  date?: string;
  rawInput?: string;
}

interface PageProps {
  searchParams: Promise<AddPageSearchParams>;
}

// Builds the same ParsedTransaction shape parse-transaction.ts produces, out
// of the query params components/chat/chat-interface.tsx's "ویرایش کن"
// button sets (see handleEditSuggestion there) - the handoff for a
// suggested-but-unsaved transaction, distinct from editId's "load an
// existing DB row" path below. Returns null on any malformed/tampered
// param rather than crashing the page; the form just falls back to its
// normal blank "input" stage in that case.
function parseSuggestionParams(params: AddPageSearchParams): {
  transaction: ParsedTransaction;
  rawInput: string;
} | null {
  if (params.fromSuggestion !== "1") return null;

  const amount = Number(params.amount);
  const type = params.type === "income" || params.type === "expense" ? (params.type as CategoryType) : null;
  const category = params.category;
  const description = params.description;
  const date = params.date;
  const rawInput = params.rawInput;

  if (!Number.isFinite(amount) || amount <= 0 || !type || !category || !description || !date || !rawInput) {
    return null;
  }

  return { transaction: { amount, type, category, description, date }, rawInput };
}

export default async function AddTransactionPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect("/login");

  const resolvedSearchParams = await searchParams;
  const { editId } = resolvedSearchParams;
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

  const suggestion = parseSuggestionParams(resolvedSearchParams);
  if (suggestion) {
    return (
      <AddTransactionForm
        categories={categories}
        accounts={accounts}
        defaultAccountId={defaultAccount.id}
        initialTransaction={suggestion.transaction}
        initialRawInput={suggestion.rawInput}
      />
    );
  }

  return <AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={defaultAccount.id} />;
}
