"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { XIcon, TransferIcon } from "@/components/icons";
import { formatToman, formatDecimal } from "@/lib/format";

// Local shape rather than importing IncomeReaction from lib/data/dashboard.ts -
// that file is "server-only", same precedent as SavingsManager's own local
// SavingsStrategy/SavingsFormulaSuggestion interfaces.
interface IncomeReactionItem {
  strategyId: number;
  label: string;
  percent: number;
  suggestedAmount: number;
  transferHref: string | null;
}

/**
 * Shown right after the user logs real income (see getDashboardData's
 * incomeReaction) - what each active percent-based savings strategy says to
 * set aside from it, each with a plain Link into the prefilled transfer form
 * (same shortcut as the savings page's own). Dismissal (the X button, or
 * clicking through to a transfer) is remembered per income event in
 * localStorage, keyed by the income transaction's id - so it stays gone on
 * later visits within INCOME_REACTION_WINDOW_MS, but a newly logged income
 * (different id) shows the banner again. No fetch, no server-side state.
 */
export function IncomeReactionBanner({
  incomeTransactionId,
  incomeAmount,
  items,
}: {
  incomeTransactionId: number;
  incomeAmount: number;
  items: IncomeReactionItem[];
}) {
  const storageKey = `jib:income-reaction-dismissed:${incomeTransactionId}`;
  // Starts false and is only flipped after mount, so the server render and
  // first client render match (no hydration mismatch).
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // localStorage can throw (some browser privacy modes) - fail open, i.e.
    // behave as "not dismissed".
    try {
      if (localStorage.getItem(storageKey) === "1") {
        // Syncing from an external store (localStorage) after mount is the
        // point here - reading it during render would mismatch the server HTML.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDismissed(true);
      }
    } catch {}
  }, [storageKey]);

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(storageKey, "1");
    } catch {}
  }

  if (dismissed) return null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">
          طبق برنامه‌ات، این درآمد {formatToman(incomeAmount)}‌ی یعنی...
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="بستن"
          className="shrink-0 rounded-full p-1 text-muted hover:bg-background"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item.strategyId} className="flex items-center justify-between gap-2">
            <span className="text-sm tabular-fa text-foreground">
              {`طبق «${item.label}» (${formatDecimal(item.percent, 1)}٪): ${formatToman(item.suggestedAmount)}`}
            </span>
            {item.transferHref && (
              <Link
                href={item.transferHref}
                onClick={dismiss}
                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary"
              >
                <TransferIcon className="h-3.5 w-3.5" />
                انتقال
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
