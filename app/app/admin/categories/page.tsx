import { listDefaultCategories } from "@/lib/data/admin-categories";
import { DefaultCategoriesManager } from "@/components/admin/default-categories-manager";

export const dynamic = "force-dynamic";

export default async function AdminDefaultCategoriesPage() {
  const categories = await listDefaultCategories();

  return <DefaultCategoriesManager categories={categories} />;
}
