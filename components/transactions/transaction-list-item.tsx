"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TransactionRow } from "./transaction-row";
import { TrashIcon, SpinnerIcon, EditIcon } from "@/components/icons";

interface Props {
  id: number;
  description: string | null;
  rawInput: string;
  date: Date;
  amount: number;
  type: string;
  category: { name: string; icon: string; color: string };
  enrichmentStatus?: string | null;
}

export function TransactionListItem(props: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/transactions/${props.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در حذف تراکنش.");
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
          <TransactionRow
            description={props.description}
            rawInput={props.rawInput}
            date={props.date}
            amount={props.amount}
            type={props.type}
            category={props.category}
            enrichmentStatus={props.enrichmentStatus}
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
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => router.push(`/app/add?editId=${props.id}`)}
              aria-label="ویرایش تراکنش"
              className="shrink-0 rounded-full p-2 text-muted transition-colors hover:bg-background hover:text-accent"
            >
              <EditIcon className="h-4 w-4" />
            </button>
            <button
              onClick={() => setConfirming(true)}
              aria-label="حذف تراکنش"
              className="shrink-0 rounded-full p-2 text-muted transition-colors hover:bg-background hover:text-warning"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      {error && <p className="pb-2 text-xs text-warning">{error}</p>}
    </div>
  );
}
