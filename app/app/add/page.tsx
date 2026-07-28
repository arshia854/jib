import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listCategories } from "@/lib/data/categories";
import { AddTransactionForm } from "@/components/transactions/add-transaction-form";

export const dynamic = "force-dynamic";

export default async function AddTransactionPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const categories = await listCategories(session.userId);
  return <AddTransactionForm categories={categories} />;
}
