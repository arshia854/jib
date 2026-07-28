import { listCategoriesWithUsage } from "@/lib/data/categories";
import { CategoriesManager } from "@/components/categories/categories-manager";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const categories = await listCategoriesWithUsage();
  return <CategoriesManager categories={categories} />;
}
