import { listCategories } from "@/lib/data/categories";
import { AddTransactionForm } from "@/components/transactions/add-transaction-form";

export const dynamic = "force-dynamic";

export default async function AddTransactionPage() {
  const categories = await listCategories();
  return <AddTransactionForm categories={categories} />;
}
