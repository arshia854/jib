// Pieces shared between add-transaction-form.tsx (single-transaction flow)
// and batch-add-transaction-form.tsx (batch mode) - pulled out to their own
// module rather than exported from add-transaction-form.tsx directly so
// neither file needs to import from the other (add-transaction-form.tsx
// renders <BatchAddTransactionForm> when batch mode is toggled on - see its
// own `mode` state - which would otherwise be a circular import).
//
// Everything here is either a pure helper, a fetch-only request wrapper, or
// a small presentational component with no state of its own - each
// caller still owns its own loading/error state and decides what to do
// with the result, exactly as before this file existed.

import { formatDecimal } from "@/lib/format";
import type { ParsedTransaction, SuggestedCategoryWithIcon, AssetPurchaseSuggestion } from "@/lib/ai/parse-transaction";
import { getAssetTypeOption } from "@/lib/assets";
import { findMatchingAccount, type AccountOption } from "@/lib/accounts";
import type { CategoryType } from "@/lib/categories";
import { getBankLabel } from "@/lib/bank/labels";
import { enqueueTransaction, deleteQueuedTransaction } from "@/lib/offline/transaction-queue";

export interface CategoryOption {
  id: number;
  name: string;
  icon: string;
  color: string;
  type: string;
}

// Shown whenever the add-transaction textarea's automatic live-preview
// parse (or, in batch mode, a row's parse) is temporarily blocked by
// TRANSACTION_PARSE_USER_RULE (lib/rate-limit.ts) - same copy everywhere
// this can happen, not a reworded per-surface duplicate.
export const PARSE_RATE_LIMIT_MESSAGE =
  "پیش‌نمایش خودکار به‌دلیل تعداد زیاد درخواست موقتاً متوقف شد؛ کمی صبر کن، خودش دوباره فعال می‌شود.";

// Shared by the single-transaction flow's inline live-preview card and full
// preview stage, and by each row of batch mode's condensed preview -
// bank-sms transactions can be submitted directly from any of them, so all
// need the same "no matching account" nudge, not just one surface's copy.
export function getMissingBankAccountLabel(
  transaction: Pick<ParsedTransaction, "source" | "bank"> | null,
  accounts: AccountOption[]
): string | null {
  if (!transaction || transaction.source !== "bank-sms" || !transaction.bank || transaction.bank === "unknown") {
    return null;
  }
  const label = getBankLabel(transaction.bank);
  return findMatchingAccount(accounts, label) ? null : label;
}

// Phase 8 (docs/roadmap-status.md): wires the named confidence levels into
// the needsConfirmation warning as a supplementary hint, not a replacement
// for it - needsConfirmation itself still gates whether this warning shows
// at all (see lib/ai/confidence.ts's top-of-file note on why retrofitting
// that gate from confidenceLevel was deliberately rejected).
// categorizationConfidence: "low" (bank-SMS with no merchant match, or an
// AI guess below the 0.50 floor) gets a stronger nudge to pick the
// category deliberately; "medium" (an AI guess in the 0.50-0.79 band, or a
// findSimilarCategory name-match override) keeps the softer, already-
// shipped "please double check" wording.
export function getConfirmationHintText(parsed: ParsedTransaction): string {
  if (parsed.source === "bank-sms") return "چی خریدی؟ کمکم کن درست دسته‌بندی‌ش کنم 🙂";
  if (parsed.categorizationConfidence === "low") return "دسته‌بندی را مطمئن نیستم، لطفاً خودت انتخاب کن";
  return "دسته‌بندی پیشنهادی است، لطفاً بررسی کنید";
}

// Shown whenever lib/ai/parse-transaction.ts detected the text as buying a
// live-priced asset (gold/usd/bitcoin) to hold as an investment - checked
// by default (unchecking it keeps the expense transaction but skips
// creating the matching Asset row, for when the AI got this wrong).
export function AssetPurchaseNotice({
  assetSuggestion,
  included,
  onToggle,
}: {
  assetSuggestion: AssetPurchaseSuggestion;
  included: boolean;
  onToggle: (value: boolean) => void;
}) {
  const option = getAssetTypeOption(assetSuggestion.type);
  return (
    <label className="mt-3 flex items-start gap-2 rounded-xl bg-accent/10 px-3 py-2 text-xs text-accent">
      <input
        type="checkbox"
        checked={included}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-0.5 shrink-0"
      />
      <span>
        {option?.icon} {formatDecimal(assetSuggestion.quantity, 4)}
        {option?.unitLabel ? ` ${option.unitLabel}` : ""} {option?.label ?? ""} هم به دارایی‌هات اضافه شود
      </span>
    </label>
  );
}

// The fetch-only halves of each form's own handleCreateBankAccount/
// handleCreateCategory - only the request itself is shared; each caller
// still owns its own loading/error state and what it does with the result
// (add-transaction-form.tsx writes straight into `accounts`/`categories`
// state; batch-add-transaction-form.tsx applies the same thing per-row).
export async function submitCreateBankAccount(name: string): Promise<{ account: AccountOption } | { error: string }> {
  try {
    const res = await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type: "bank", initialBalance: 0 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "خطا در ساخت حساب.");
    return { account: data.account };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "خطای ناشناخته رخ داد." };
  }
}

export async function submitCreateCategory(
  suggestion: SuggestedCategoryWithIcon,
  type: CategoryType
): Promise<{ category: CategoryOption } | { error: string }> {
  try {
    const res = await fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: suggestion.name,
        parentName: suggestion.parentName,
        icon: suggestion.icon,
        type,
        source: "ai-suggestion",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "خطا در ساخت دسته‌بندی.");
    return { category: data.category };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "خطای ناشناخته رخ داد." };
  }
}

// Shape of the POST /api/transactions body - shared between a single create
// (add-transaction-form.tsx's saveTransaction) and each row of batch mode's
// sequential "ثبت همه", so both send byte-for-byte the same payload the
// server actually reads (see that route's own body parsing).
export interface CreateTransactionPayload {
  amount: number;
  type: CategoryType;
  category: string;
  description?: string;
  date: string;
  rawInput: string;
  accountId: number;
  idempotencyKey: string;
  source?: "assistant-suggestion";
  quick?: true;
  assetPurchase?: {
    type: AssetPurchaseSuggestion["type"];
    quantity: number;
    purchasePricePerUnit: number;
  };
}

export type CreateTransactionResult =
  | { status: "queued" }
  | { status: "success"; transaction: unknown; asset: unknown }
  | { status: "error"; message: string };

// The create-path (POST /api/transactions) half of saveTransaction, pulled
// out so batch mode's per-row sequential submit reuses the exact same
// offline-queue/idempotency/error handling instead of a copy-pasted
// duplicate. Create-only - the PATCH/edit path stays inline in
// add-transaction-form.tsx since edits never go through the offline queue
// and batch mode has no edit path at all (fresh-add only, per this
// feature's own brief).
export async function submitCreateTransaction(payload: CreateTransactionPayload): Promise<CreateTransactionResult> {
  // Written to IndexedDB *before* the network attempt below, on every
  // submit regardless of actual connectivity - same code path online or
  // offline - so a tab closed right after this line still has the item
  // recorded when it reopens.
  try {
    await enqueueTransaction(payload);
  } catch {
    // IndexedDB unavailable (SSR/old browser/storage disabled) - offline
    // queuing is a progressive enhancement, same precedent as
    // ServiceWorkerRegister's own catch-and-ignore; the fetch below still
    // runs normally either way.
  }

  let res: Response;
  try {
    res = await fetch("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // No connectivity: the "pending" row written above stays queued;
    // OfflineSyncRegister's `online` listener (via lib/offline/
    // sync-transactions.ts) retries it automatically once the browser
    // reconnects, reusing this same idempotencyKey. From the caller's point
    // of view this submit succeeded (optimistically).
    return { status: "queued" };
  }

  try {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "خطا در ذخیره تراکنش.");
    // Server-confirmed create - the queued row's job is done. Best-effort:
    // a failed cleanup here isn't user-visible (the pending list only shows
    // non-"synced" rows) and would just be a harmless no-op the next time
    // anything touches this key.
    deleteQueuedTransaction(payload.idempotencyKey).catch(() => {});
    return { status: "success", transaction: data.transaction, asset: data.asset ?? null };
  } catch (err) {
    // A real server-side rejection (validation/auth) or a malformed
    // response, not a connectivity failure - that's handled above. There's
    // nothing left for the offline queue to retry - remove the row instead
    // of leaving a ghost "failed" entry for something already surfaced to
    // the caller as an error.
    deleteQueuedTransaction(payload.idempotencyKey).catch(() => {});
    return { status: "error", message: err instanceof Error ? err.message : "خطای ناشناخته رخ داد." };
  }
}
