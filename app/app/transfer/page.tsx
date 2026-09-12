import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listAccounts } from "@/lib/data/accounts";
import { TransferForm } from "@/components/transactions/transfer-form";
import { EmptyState } from "@/components/empty-state";
import { WalletIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

// Phase A3 (docs/roadmap-status.md savings roadmap): dedicated route, same
// pattern as app/app/add/page.tsx (a server component fetching what the
// client form needs, rendering one client component) - not a modal, to
// match add-transaction's own entry-point convention (see this route's
// only Link, in components/accounts/accounts-manager.tsx's header).
export default async function TransferPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const accounts = await listAccounts(session.userId);

  // TransferForm assumes it always has a real "other side" to pick -
  // fewer than 2 accounts means there's nothing to transfer between, so
  // this stops here rather than rendering a form whose from/to selects
  // would otherwise have to default to the same single account.
  if (accounts.length < 2) {
    return (
      <div className="px-4 pb-6 pt-6">
        <EmptyState
          icon={<WalletIcon className="h-6 w-6" />}
          title="حداقل به دو حساب نیاز داری"
          description="برای انتقال بین حساب‌ها، اول یک حساب دیگر بساز."
          action={{ href: "/app/settings/accounts", label: "افزودن حساب" }}
        />
      </div>
    );
  }

  return <TransferForm accounts={accounts} />;
}
