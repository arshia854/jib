import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listCategoriesWithUsage } from "@/lib/data/categories";
import { CategoriesManager } from "@/components/categories/categories-manager";
import { BackIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function SettingsCategoriesPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const categories = await listCategoriesWithUsage(session.userId);

  return (
    <div>
      <div className="flex items-center gap-2 px-4 pt-4">
        <Link
          href="/app/settings"
          aria-label="بازگشت به تنظیمات"
          className="rounded-full p-1.5 text-muted hover:bg-surface hover:text-foreground"
        >
          <BackIcon className="h-5 w-5" />
        </Link>
        <span className="text-xs text-muted">تنظیمات</span>
      </div>
      <CategoriesManager categories={categories} />
    </div>
  );
}
