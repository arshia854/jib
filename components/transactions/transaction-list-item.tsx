"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TransactionRow } from "./transaction-row";
import { TrashIcon, SpinnerIcon } from "@/components/icons";

interface Props {
  id: number;
  description: string | null;
  rawInput: string;
  date: Date;
  amount: number;
  type: string;
  category: { name: string; icon: string; color: string };
}

export function TransactionListItem(props: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/transactions/${props.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <TransactionRow
          description={props.description}
          rawInput={props.rawInput}
          date={props.date}
          amount={props.amount}
          type={props.type}
          category={props.category}
        />
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
          aria-label="حذف تراکنش"
          className="shrink-0 rounded-full p-2 text-muted transition-colors hover:bg-background hover:text-warning"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
