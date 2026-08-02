import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listAccountsWithUsage } from "@/lib/data/accounts";
import { AccountsManager } from "@/components/accounts/accounts-manager";
import { BackIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function SettingsAccountsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const accounts = await listAccountsWithUsage(session.userId);

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
      <AccountsManager accounts={accounts} />
    </div>
  );
}
