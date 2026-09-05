"use client";

// Batch mode: up to 5 free-text transaction lines parsed and saved
// together, instead of repeating the single-transaction flow 5 times. Only
// ever rendered by add-transaction-form.tsx's fresh "add" flow (see its own
// `mode` state and render condition) - never in edit mode or the
// from-suggestion handoff, so there's no PATCH/edit path or
// initialTransaction handoff to account for here.
//
// Reuses, rather than reimplements, everything that already exists for a
// single transaction: AssetPurchaseNotice, getMissingBankAccountLabel,
// getConfirmationHintText, submitCreateBankAccount/submitCreateCategory
// (the fetch halves of "create it?" flows), and submitCreateTransaction
// (the exact same offline-queue/idempotency/POST /api/transactions path
// saveTransaction() uses) - all in transaction-form-shared.tsx, imported
// below, not copy-pasted.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, TrashIcon, CheckIcon, XIcon, SpinnerIcon } from "@/components/icons";
import { formatNumber } from "@/lib/format";
import { toLatinDigits } from "@/lib/normalize";
import type { ParsedTransaction } from "@/lib/ai/parse-transaction";
import { getAccountTypeIcon, type AccountOption } from "@/lib/accounts";
import {
  type CategoryOption,
  type CreateTransactionPayload,
  PARSE_RATE_LIMIT_MESSAGE,
  getMissingBankAccountLabel,
  getConfirmationHintText,
  AssetPurchaseNotice,
  submitCreateBankAccount,
  submitCreateCategory,
  submitCreateTransaction,
} from "@/components/transactions/transaction-form-shared";

const MAX_ROWS = 5;
const MIN_ROWS = 1;

type SaveStatus = "idle" | "saving" | "success" | "failed";

interface BatchRow {
  id: string;
  text: string;
  parsed: ParsedTransaction | null;
  // The `text` value `parsed` was produced from - null means never parsed.
  // A row whose `text` no longer matches this is stale: its preview (if
  // any) is hidden and it's excluded from both re-parsing-skip and
  // submission until reprocessed. Mirrors the single-transaction flow's own
  // "a fresh parse is a new attempt" idea (see idempotencyKeyRef's comment
  // there), just tracked per row instead of in one ref.
  lastParsedText: string | null;
  parseError: string | null;
  isParsing: boolean;
  includeAssetPurchase: boolean;
  isCreatingCategory: boolean;
  createCategoryError: string | null;
  saveStatus: SaveStatus;
  saveError: string | null;
  // SEC-10 idempotency key for this row's submit attempt - generated once,
  // on first save, and reused on a retry of the same row (same reasoning as
  // add-transaction-form.tsx's idempotencyKeyRef). Cleared whenever the row
  // is freshly (re)parsed, since that's a new attempt.
  idempotencyKey: string | null;
}

function createRow(): BatchRow {
  return {
    id: crypto.randomUUID(),
    text: "",
    parsed: null,
    lastParsedText: null,
    parseError: null,
    isParsing: false,
    includeAssetPurchase: true,
    isCreatingCategory: false,
    createCategoryError: null,
    saveStatus: "idle",
    saveError: null,
    idempotencyKey: null,
  };
}

export function BatchAddTransactionForm({
  categories,
  accounts,
  accountId,
  onAccountIdChange,
  onCategoriesChange,
  onAccountsChange,
}: {
  categories: CategoryOption[];
  accounts: AccountOption[];
  accountId: number;
  onAccountIdChange: (id: number) => void;
  onCategoriesChange: (updater: (prev: CategoryOption[]) => CategoryOption[]) => void;
  onAccountsChange: (updater: (prev: AccountOption[]) => AccountOption[]) => void;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<BatchRow[]>(() => [createRow(), createRow()]);
  const [isProcessingAll, setIsProcessingAll] = useState(false);
  const [isSavingAll, setIsSavingAll] = useState(false);
  // Shared cooldown across all rows, same idea as the single-transaction
  // flow's own parseLimitedUntil - one 429 anywhere in the batch means the
  // per-user parse rate limit is exhausted for everyone, not just that row.
  // Tracked as a plain boolean (flipped by a setTimeout below, not compared
  // against Date.now() during render) - reading the clock is only safe from
  // an event handler/effect, never from the render body itself.
  const [isRateLimited, setIsRateLimited] = useState(false);
  const rateLimitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isCreatingBankAccount, setIsCreatingBankAccount] = useState(false);
  const [createAccountError, setCreateAccountError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (rateLimitTimeoutRef.current) clearTimeout(rateLimitTimeoutRef.current);
    };
  }, []);

  const isBusy = isProcessingAll || isSavingAll;

  function updateRow(id: string, patch: Partial<BatchRow> | ((row: BatchRow) => Partial<BatchRow>)) {
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...(typeof patch === "function" ? patch(row) : patch) } : row))
    );
  }

  function handleAddRow() {
    setRows((prev) => (prev.length >= MAX_ROWS ? prev : [...prev, createRow()]));
  }

  function handleRemoveRow(id: string) {
    setRows((prev) => (prev.length <= MIN_ROWS ? prev : prev.filter((row) => row.id !== id)));
  }

  // Parses every row whose text isn't already reflected by its current
  // parsed/parseError result - re-clicking after fixing just one failed
  // row's text only spends a fresh AI call on that row, not the whole
  // batch again. Parallel Promise.all across rows (fine per this feature's
  // own brief given TRANSACTION_PARSE_USER_RULE's headroom) - each row
  // still hits the exact same rate-limited POST /api/transactions/parse
  // the single-transaction flow uses, unmodified; nothing here raises or
  // bypasses that limit (see lib/rate-limit.ts).
  async function handleProcessAll() {
    if (isRateLimited) return;
    const toParse = rows.filter((row) => row.text.trim().length >= 4 && row.text !== row.lastParsedText);
    if (toParse.length === 0) return;

    setIsProcessingAll(true);
    toParse.forEach((row) => updateRow(row.id, { isParsing: true, parseError: null }));

    // Local accumulator, not state - the actual setIsRateLimited/setTimeout
    // scheduling happens once, after every row has settled, from this event
    // handler (never from render - see isRateLimited's own comment above).
    let maxRetryAfterSeconds = 0;

    await Promise.all(
      toParse.map(async (row) => {
        const trimmed = row.text.trim();
        try {
          const res = await fetch("/api/transactions/parse", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: trimmed }),
          });

          if (res.status === 429) {
            const data = await res.json().catch(() => ({}));
            const retryAfterSeconds =
              typeof data.retryAfterSeconds === "number" && data.retryAfterSeconds > 0 ? data.retryAfterSeconds : 60;
            maxRetryAfterSeconds = Math.max(maxRetryAfterSeconds, retryAfterSeconds);
            updateRow(row.id, { isParsing: false, parseError: PARSE_RATE_LIMIT_MESSAGE, lastParsedText: row.text });
            return;
          }

          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "خطا در پردازش متن.");

          updateRow(row.id, {
            isParsing: false,
            parsed: data.parsed,
            parseError: null,
            lastParsedText: row.text,
            includeAssetPurchase: true,
            // A fresh successful parse is a new attempt - any earlier failed
            // save (and the key it used) no longer applies.
            idempotencyKey: null,
            saveStatus: "idle",
            saveError: null,
          });
        } catch (err) {
          updateRow(row.id, {
            isParsing: false,
            parseError: err instanceof Error ? err.message : "خطای ناشناخته رخ داد.",
            lastParsedText: row.text,
          });
        }
      })
    );

    if (maxRetryAfterSeconds > 0) {
      setIsRateLimited(true);
      if (rateLimitTimeoutRef.current) clearTimeout(rateLimitTimeoutRef.current);
      rateLimitTimeoutRef.current = setTimeout(() => setIsRateLimited(false), maxRetryAfterSeconds * 1000);
    }

    setIsProcessingAll(false);
  }

  async function handleCreateCategoryForRow(row: BatchRow) {
    if (!row.parsed?.suggestedCategory) return;
    updateRow(row.id, { isCreatingCategory: true, createCategoryError: null });
    const result = await submitCreateCategory(row.parsed.suggestedCategory, row.parsed.type);
    if ("error" in result) {
      updateRow(row.id, { isCreatingCategory: false, createCategoryError: result.error });
      return;
    }
    // 200 (resolvedExisting) can return a category already in the shared list - dedupe on id.
    onCategoriesChange((prev) => (prev.some((c) => c.id === result.category.id) ? prev : [...prev, result.category]));
    updateRow(row.id, (r) => ({
      isCreatingCategory: false,
      parsed: r.parsed ? { ...r.parsed, category: result.category.name, suggestedCategory: undefined } : r.parsed,
    }));
  }

  async function handleCreateBankAccount(name: string) {
    setIsCreatingBankAccount(true);
    setCreateAccountError(null);
    const result = await submitCreateBankAccount(name);
    if ("error" in result) {
      setCreateAccountError(result.error);
    } else {
      onAccountsChange((prev) => [...prev, result.account]);
      onAccountIdChange(result.account.id);
    }
    setIsCreatingBankAccount(false);
  }

  const submittableRows = rows.filter(
    (row) => row.parsed && row.text === row.lastParsedText && row.saveStatus !== "success"
  );

  // Sequential (not parallel) submit, same per-item save path as
  // saveTransaction() in add-transaction-form.tsx: a fresh idempotency key
  // per item (reused across retries of that same row), enqueueTransaction
  // before the network call, POST /api/transactions, deleteQueuedTransaction
  // on confirmed success - all via submitCreateTransaction. One row's
  // failure never stops the rest; only fully-succeeded rows are removed.
  async function handleSaveAll() {
    if (submittableRows.length === 0 || isBusy) return;

    setIsSavingAll(true);
    setRows((prev) =>
      prev.map((row) =>
        submittableRows.some((r) => r.id === row.id) ? { ...row, saveStatus: "saving", saveError: null } : row
      )
    );

    let allSucceeded = true;

    for (const row of submittableRows) {
      const transaction = row.parsed!;
      const idempotencyKey = row.idempotencyKey ?? crypto.randomUUID();

      const payload: CreateTransactionPayload = {
        amount: transaction.amount,
        type: transaction.type,
        category: transaction.category,
        description: transaction.description,
        date: transaction.date,
        rawInput: row.text.trim(),
        accountId,
        idempotencyKey,
        ...(transaction.assetSuggestion && row.includeAssetPurchase
          ? {
              assetPurchase: {
                type: transaction.assetSuggestion.type,
                quantity: transaction.assetSuggestion.quantity,
                purchasePricePerUnit: transaction.assetSuggestion.purchasePricePerUnit,
              },
            }
          : {}),
      };

      const result = await submitCreateTransaction(payload);

      if (result.status === "error") {
        allSucceeded = false;
        updateRow(row.id, { saveStatus: "failed", saveError: result.message, idempotencyKey });
        continue;
      }

      // "queued" (offline) is treated as an optimistic success here too,
      // same as the single-transaction flow - the item is safely queued
      // and OfflineSyncRegister retries it once connectivity returns.
      updateRow(row.id, { saveStatus: "success", saveError: null, idempotencyKey });
    }

    setIsSavingAll(false);

    if (allSucceeded) {
      router.push("/app/transactions");
      router.refresh();
      return;
    }

    // Some rows failed: stay on the page, drop the succeeded rows (their
    // job is done), keep failed/unparsed rows visible with their errors so
    // the user can fix and retry just those via "ثبت همه" again.
    setRows((prev) => {
      const remaining = prev.filter((row) => row.saveStatus !== "success");
      return remaining.length > 0 ? remaining : [createRow(), createRow()];
    });
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div>
        <label className="block text-xs text-muted">حساب (برای همه ردیف‌ها)</label>
        <select
          value={accountId}
          onChange={(e) => onAccountIdChange(Number(e.target.value))}
          disabled={isBusy}
          className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent disabled:opacity-50"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {getAccountTypeIcon(a.type)} {a.name}
            </option>
          ))}
        </select>
        {createAccountError && <p className="mt-1.5 text-xs text-warning">{createAccountError}</p>}
      </div>

      <div className="flex flex-col gap-3">
        {rows.map((row, index) => {
          const isStale = row.parsed !== null && row.text !== row.lastParsedText;
          const showPreview = row.parsed !== null && !isStale;
          const rowCategories = showPreview ? categories.filter((c) => c.type === row.parsed!.type) : [];
          const missingBankAccountLabel = showPreview ? getMissingBankAccountLabel(row.parsed, accounts) : null;

          return (
            <div key={row.id} className="rounded-2xl border border-border bg-surface p-3">
              <div className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-center text-xs text-muted">{index + 1}</span>
                <input
                  type="text"
                  value={row.text}
                  onChange={(e) => updateRow(row.id, { text: e.target.value })}
                  placeholder="مثلاً: ۵۰ هزار تومن ناهار خوردم"
                  disabled={isBusy}
                  className="flex-1 rounded-xl border border-border bg-background p-2.5 text-sm text-foreground outline-none focus:border-accent disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => handleRemoveRow(row.id)}
                  disabled={isBusy || rows.length <= MIN_ROWS}
                  aria-label="حذف ردیف"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:text-warning disabled:opacity-30"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>

              {row.isParsing && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                  <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                  در حال پردازش...
                </p>
              )}

              {isStale && !row.isParsing && (
                <p className="mt-2 text-xs text-muted">این ردیف تغییر کرده — با «پردازش همه» دوباره پردازش می‌شود.</p>
              )}

              {row.parseError && !row.isParsing && (
                <p className="mt-2 text-xs text-warning">{row.parseError}</p>
              )}

              {showPreview && (
                <div className="mt-3 border-t border-border pt-3">
                  <div className="flex gap-2">
                    {(["expense", "income"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          updateRow(row.id, (r) => ({
                            parsed: r.parsed
                              ? {
                                  ...r.parsed,
                                  type: t,
                                  category: categories.find((c) => c.type === t)?.name ?? r.parsed.category,
                                }
                              : r.parsed,
                          }))
                        }
                        className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                          row.parsed!.type === t ? "bg-primary text-on-primary" : "bg-background text-muted"
                        }`}
                      >
                        {t === "income" ? "درآمد" : "هزینه"}
                      </button>
                    ))}
                  </div>

                  <div className="mt-2 flex gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={formatNumber(row.parsed!.amount)}
                      disabled={isBusy}
                      onChange={(e) => {
                        const digits = toLatinDigits(e.target.value).replace(/[^0-9]/g, "");
                        updateRow(row.id, (r) => ({
                          parsed: r.parsed ? { ...r.parsed, amount: digits ? Number(digits) : 0 } : r.parsed,
                        }));
                      }}
                      className="w-1/2 rounded-lg border border-border bg-background p-2 text-sm tabular-fa outline-none focus:border-accent disabled:opacity-50"
                    />
                    <select
                      value={row.parsed!.category}
                      disabled={isBusy}
                      onChange={(e) =>
                        updateRow(row.id, (r) => (r.parsed ? { parsed: { ...r.parsed, category: e.target.value } } : {}))
                      }
                      className="w-1/2 rounded-lg border border-border bg-background p-2 text-sm outline-none focus:border-accent disabled:opacity-50"
                    >
                      {rowCategories.map((c) => (
                        <option key={c.id} value={c.name}>
                          {c.icon} {c.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <input
                    type="text"
                    value={row.parsed!.description}
                    disabled={isBusy}
                    onChange={(e) =>
                      updateRow(row.id, (r) => (r.parsed ? { parsed: { ...r.parsed, description: e.target.value } } : {}))
                    }
                    placeholder="توضیح"
                    className="mt-2 w-full rounded-lg border border-border bg-background p-2 text-sm outline-none focus:border-accent disabled:opacity-50"
                  />

                  <input
                    type="date"
                    value={row.parsed!.date}
                    disabled={isBusy}
                    onChange={(e) =>
                      updateRow(row.id, (r) => (r.parsed ? { parsed: { ...r.parsed, date: e.target.value } } : {}))
                    }
                    className="mt-2 w-full rounded-lg border border-border bg-background p-2 text-sm tabular-fa outline-none focus:border-accent disabled:opacity-50"
                  />

                  {row.parsed!.needsConfirmation && (
                    <p className="mt-1.5 text-xs text-warning">{getConfirmationHintText(row.parsed!)}</p>
                  )}

                  {row.parsed!.suggestedCategory && (
                    <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-accent/10 px-3 py-2">
                      <p className="text-xs text-accent">
                        دسته‌بندی «{row.parsed!.suggestedCategory.icon} {row.parsed!.suggestedCategory.name}» براش پیدا
                        نشد — می‌خوای بسازمش؟
                      </p>
                      <button
                        type="button"
                        onClick={() => handleCreateCategoryForRow(row)}
                        disabled={row.isCreatingCategory || isBusy}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
                      >
                        {row.isCreatingCategory && <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
                        بساز
                      </button>
                    </div>
                  )}
                  {row.createCategoryError && <p className="mt-1.5 text-xs text-warning">{row.createCategoryError}</p>}

                  {row.parsed!.assetSuggestion && (
                    <AssetPurchaseNotice
                      assetSuggestion={row.parsed!.assetSuggestion}
                      included={row.includeAssetPurchase}
                      onToggle={(value) => updateRow(row.id, { includeAssetPurchase: value })}
                    />
                  )}

                  {missingBankAccountLabel && (
                    <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-accent/10 px-3 py-2">
                      <p className="text-xs text-accent">حساب {missingBankAccountLabel} پیدا نشد — می‌خواهید بسازید؟</p>
                      <button
                        type="button"
                        onClick={() => handleCreateBankAccount(missingBankAccountLabel)}
                        disabled={isCreatingBankAccount || isBusy}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
                      >
                        {isCreatingBankAccount && <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
                        ساخت حساب
                      </button>
                    </div>
                  )}

                  <div className="mt-2">
                    {row.saveStatus === "saving" && (
                      <p className="flex items-center gap-1.5 text-xs text-muted">
                        <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                        در حال ذخیره...
                      </p>
                    )}
                    {row.saveStatus === "success" && (
                      <p className="flex items-center gap-1.5 text-xs text-success">
                        <CheckIcon className="h-3.5 w-3.5" />
                        ثبت شد
                      </p>
                    )}
                    {row.saveStatus === "failed" && (
                      <p className="flex items-center gap-1.5 text-xs text-warning">
                        <XIcon className="h-3.5 w-3.5" />
                        {row.saveError}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={handleAddRow}
        disabled={isBusy || rows.length >= MAX_ROWS}
        className="flex items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border py-2.5 text-xs font-semibold text-accent disabled:opacity-50"
      >
        <PlusIcon className="h-4 w-4" />
        افزودن ردیف
      </button>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleProcessAll}
          disabled={isBusy || isRateLimited || rows.every((r) => r.text.trim().length < 4 || r.text === r.lastParsedText)}
          className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary disabled:opacity-50"
        >
          {isProcessingAll && <SpinnerIcon className="h-4 w-4 animate-spin" />}
          پردازش همه
        </button>
        <button
          type="button"
          onClick={handleSaveAll}
          disabled={isBusy || submittableRows.length === 0}
          className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-accent py-3.5 text-sm font-semibold text-accent disabled:opacity-50"
        >
          {isSavingAll && <SpinnerIcon className="h-4 w-4 animate-spin" />}
          ثبت همه
        </button>
      </div>
      {isRateLimited && <p className="text-xs text-warning">{PARSE_RATE_LIMIT_MESSAGE}</p>}
    </div>
  );
}
