import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listCategoriesWithUsage } from "@/lib/data/categories";
import { CategoriesManager } from "@/components/categories/categories-manager";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const categories = await listCategoriesWithUsage(session.userId);
  return <CategoriesManager categories={categories} />;
}
