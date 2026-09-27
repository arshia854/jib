"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TransferRow } from "./transfer-row";
import { TrashIcon, SpinnerIcon } from "@/components/icons";

interface Props {
  transferGroupId: string;
  fromAccountName: string;
  toAccountName: string;
  amount: number;
  date: Date;
}

// Phase A3 (docs/roadmap-status.md savings roadmap): the interactive
// (paginated transactions tab) counterpart to TransferRow, same relationship
// TransactionListItem has to TransactionRow - and the same confirm-before-
// delete shape as TransactionListItem's own handleDelete (a "حذف"/"انصراف"
// pair replacing the row's trailing actions, no window.confirm) - just
// calling DELETE /api/transfers/[transferGroupId] instead of
// /api/transactions/[id], since deleting a transfer removes both legs of
// the pair at once (see lib/data/transfers.ts's deleteTransfer). No edit
// action - unlike a regular transaction, nothing in this phase's brief asks
// for editing an existing transfer, only creating and deleting one.
export function TransferListItem({ transferGroupId, fromAccountName, toAccountName, amount, date }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/transfers/${transferGroupId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در حذف انتقال.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <TransferRow fromAccountName={fromAccountName} toAccountName={toAccountName} amount={amount} date={date} />
        </div>
        {confirming ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-lg bg-warning px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {deleting ? <SpinnerIcon className="h-3.5 w-3.5 animate-spin" /> : "حذف"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={deleting}
              className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted"
            >
              انصراف
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            aria-label="حذف انتقال"
            className="shrink-0 rounded-full p-2 text-muted transition-colors hover:bg-background hover:text-warning"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      {error && <p className="pb-2 text-xs text-warning">{error}</p>}
    </div>
  );
}
