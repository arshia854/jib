import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listAccounts } from "@/lib/data/accounts";
import { TransferForm } from "@/components/transactions/transfer-form";
import { EmptyState } from "@/components/empty-state";
import { WalletIcon } from "@/components/icons";
import { MAX_TRANSACTION_AMOUNT } from "@/lib/limits";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string; amount?: string; note?: string }>;
}

export interface TransferPrefill {
  from?: number;
  to?: number;
  amount?: number;
  note?: string;
}

/**
 * Validates the savings page's "do this transfer now" query params
 * (components/savings/savings-manager.tsx) against this user's own
 * `accounts` - an id that doesn't parse or isn't one of theirs, or an
 * amount that isn't a finite number in (0, MAX_TRANSACTION_AMOUNT], comes
 * back undefined rather than being trusted. `note` isn't length-checked here
 * (TransferForm's own submit-time check bounds it); it's only required to be
 * a plain string, since a repeated `?note=` param arrives as an array at
 * runtime despite the declared type. Exported (not just used inline) so this
 * parse/validate step has its own unit test (page.test.ts), same precedent
 * as app/app/transactions/page.tsx's buildTransactionsRedirectPath.
 */
export function parseTransferPrefill(
  params: { from?: string; to?: string; amount?: string; note?: string },
  accounts: { id: number }[]
): TransferPrefill {
  const accountIdOrUndefined = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const id = Number(raw);
    return Number.isInteger(id) && accounts.some((a) => a.id === id) ? id : undefined;
  };

  const rawAmount = params.amount ? Number(params.amount) : NaN;
  const amount =
    Number.isFinite(rawAmount) && rawAmount > 0 && rawAmount <= MAX_TRANSACTION_AMOUNT ? rawAmount : undefined;

  return {
    from: accountIdOrUndefined(params.from),
    to: accountIdOrUndefined(params.to),
    amount,
    note: typeof params.note === "string" ? params.note : undefined,
  };
}

// Phase A3 (docs/roadmap-status.md savings roadmap): dedicated route, same
// pattern as app/app/add/page.tsx (a server component fetching what the
// client form needs, rendering one client component) - not a modal, to
// match add-transaction's own entry-point convention (see this route's
// only Link, in components/accounts/accounts-manager.tsx's header).
export default async function TransferPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect("/login");

  const params = await searchParams;
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

  const prefill = parseTransferPrefill(params, accounts);

  return (
    <TransferForm
      accounts={accounts}
      initialFromAccountId={prefill.from}
      initialToAccountId={prefill.to}
      initialAmount={prefill.amount}
      initialNote={prefill.note}
    />
  );
}
