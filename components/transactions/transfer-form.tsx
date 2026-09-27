"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, SpinnerIcon } from "@/components/icons";
import { AmountInput } from "@/components/ui/amount-input";
import { getAccountTypeIcon, type AccountOption } from "@/lib/accounts";
import { MAX_TRANSACTION_AMOUNT, MAX_DESCRIPTION_LENGTH } from "@/lib/limits";

// Phase A3 (docs/roadmap-status.md savings roadmap): creates one internal
// transfer via POST /api/transfers (lib/data/transfers.ts's createTransfer).
// Deliberately not built on the AI-parse pipeline add-transaction-form.tsx
// uses (there's no free text to parse here - source/destination/amount are
// all picked directly) - what's matched from that file is its
// validation/error/loading-state *conventions*: client-side pre-checks that
// mirror the server's own validation messages 1:1 (same "same account"/
// "invalid amount" wording as app/api/transfers/route.ts and
// lib/data/transfers.ts, so a user sees an identical message whether the
// client or server catches it), a single `saving` boolean gating the submit
// button (spinner swapped in, same as accounts-manager.tsx's own
// handleSave), and one `error` string rendered right above the submit
// button.
//
// The four `initial*` props seed the corresponding fields' initial state
// (used by the savings page's "do this transfer now" shortcut, via
// app/app/transfer/page.tsx's query-param parsing). An account id that isn't
// in `accounts` is ignored and that side falls back to its normal default -
// a stale/bad prefill never throws or shows an error.
export function TransferForm({
  accounts,
  initialFromAccountId,
  initialToAccountId,
  initialAmount,
  initialNote,
}: {
  accounts: AccountOption[];
  initialFromAccountId?: number;
  initialToAccountId?: number;
  initialAmount?: number;
  initialNote?: string;
}) {
  const router = useRouter();
  const isKnownAccountId = (id: number | undefined): id is number => id !== undefined && accounts.some((a) => a.id === id);
  const [fromAccountId, setFromAccountId] = useState<number>(
    isKnownAccountId(initialFromAccountId) ? initialFromAccountId : (accounts[0]?.id ?? 0)
  );
  const [toAccountId, setToAccountId] = useState<number>(
    isKnownAccountId(initialToAccountId) ? initialToAccountId : (accounts[1]?.id ?? accounts[0]?.id ?? 0)
  );
  const [amount, setAmount] = useState(initialAmount !== undefined ? String(initialAmount) : "");
  const [note, setNote] = useState(initialNote ?? "");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Excludes whichever account is currently selected as the *other* side,
  // per this phase's own spec - so picking حساب A as the source removes it
  // from the destination list (and vice versa) instead of just leaving the
  // same-account case to the validation error below to catch after the
  // fact.
  const fromOptions = accounts.filter((a) => a.id !== toAccountId);
  const toOptions = accounts.filter((a) => a.id !== fromAccountId);

  async function handleSubmit() {
    if (fromAccountId === toAccountId) {
      setError("حساب مبدا و مقصد نمی‌توانند یکسان باشند.");
      return;
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > MAX_TRANSACTION_AMOUNT) {
      setError("مبلغ انتقال نامعتبر است.");
      return;
    }
    if (note.length > MAX_DESCRIPTION_LENGTH) {
      setError("توضیح خیلی طولانی است.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAccountId,
          toAccountId,
          amount: numericAmount,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(date ? { date } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "انتقال ذخیره نشد، دوباره تلاش کن.");
      router.push("/app/settings/accounts");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "یه مشکلی پیش اومد، دوباره تلاش کن.");
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col px-4 pb-6 pt-6">
      <h1 className="text-lg font-bold text-foreground">انتقال بین حساب‌ها</h1>
      <p className="mt-1 text-sm text-muted">مبلغی را از یک حساب به حساب دیگر جابه‌جا کن.</p>

      <div className="mt-6 flex flex-col gap-4">
        <div>
          <label className="block text-xs text-muted">از حساب</label>
          <select
            value={fromAccountId}
            onChange={(e) => setFromAccountId(Number(e.target.value))}
            className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
          >
            {fromOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {getAccountTypeIcon(a.type)} {a.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-muted">به حساب</label>
          <select
            value={toAccountId}
            onChange={(e) => setToAccountId(Number(e.target.value))}
            className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
          >
            {toOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {getAccountTypeIcon(a.type)} {a.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-muted">مبلغ (تومان)</label>
          <AmountInput
            value={Number(amount) || 0}
            onChange={(next) => setAmount(next ? String(next) : "")}
            placeholder="۰"
          />
        </div>

        <div>
          <label className="block text-xs text-muted">توضیح (اختیاری)</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
          />
        </div>

        <div>
          <label className="block text-xs text-muted">تاریخ (اختیاری)</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
          />
        </div>

        {error && <p className="text-sm text-warning">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={saving}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary disabled:opacity-50"
        >
          {saving ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
          ثبت انتقال
        </button>
      </div>
    </div>
  );
}
