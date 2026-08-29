"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, XIcon, SpinnerIcon, ChatIcon, ZapIcon } from "@/components/icons";
import { formatToman, formatNumber, formatDecimal, formatJalaaliDate } from "@/lib/format";
import { toLatinDigits } from "@/lib/normalize";
import type { ParsedTransaction, SuggestedCategoryWithIcon, AssetPurchaseSuggestion } from "@/lib/ai/parse-transaction";
import { getBankLabel } from "@/lib/bank/labels";
import { getAssetTypeOption } from "@/lib/assets";
import { getAccountTypeIcon, findMatchingAccount, type AccountOption } from "@/lib/accounts";
import { FALLBACK_EXPENSE_CATEGORY, type CategoryType } from "@/lib/categories";
import { extractAmount } from "@/lib/extract-amount";
import { extractDate } from "@/lib/extract-date";
import { enqueueTransaction, deleteQueuedTransaction } from "@/lib/offline/transaction-queue";

interface CategoryOption {
  id: number;
  name: string;
  icon: string;
  color: string;
  type: string;
}

interface EditTransaction extends Pick<ParsedTransaction, "amount" | "type" | "category" | "description" | "date"> {
  id: number;
  accountId: number;
}

type Stage = "input" | "preview" | "saving";

const PARSE_RATE_LIMIT_MESSAGE =
  "پیش‌نمایش خودکار به‌دلیل تعداد زیاد درخواست موقتاً متوقف شد؛ کمی صبر کن، خودش دوباره فعال می‌شود.";

// Shared by both the inline live-preview card and the full preview stage -
// bank-sms transactions can be submitted directly from either one, so both
// need the same "no matching account" nudge, not just the full-preview copy.
function getMissingBankAccountLabel(
  transaction: Pick<ParsedTransaction, "source" | "bank"> | null,
  accounts: AccountOption[]
): string | null {
  if (!transaction || transaction.source !== "bank-sms" || !transaction.bank || transaction.bank === "unknown") {
    return null;
  }
  const label = getBankLabel(transaction.bank);
  return findMatchingAccount(accounts, label) ? null : label;
}

// Phase 8 (docs/roadmap-status.md): wires the new named confidence levels
// into the existing needsConfirmation warning as a supplementary hint, not
// a replacement for it - needsConfirmation itself still gates whether this
// warning shows at all, unchanged (see lib/ai/confidence.ts's top-of-file
// note on why retrofitting that gate from confidenceLevel was deliberately
// rejected). categorizationConfidence: "low" (bank-SMS with no merchant
// match, or an AI guess below the 0.50 floor) gets a stronger nudge to
// pick the category deliberately; "medium" (an AI guess in the 0.50-0.79
// band, or a findSimilarCategory name-match override) keeps the softer,
// already-shipped "please double check" wording.
function getConfirmationHintText(parsed: ParsedTransaction): string {
  if (parsed.source === "bank-sms") return "چی خریدی؟ کمکم کن درست دسته‌بندی‌ش کنم 🙂";
  if (parsed.categorizationConfidence === "low") return "دسته‌بندی را مطمئن نیستم، لطفاً خودت انتخاب کن";
  return "دسته‌بندی پیشنهادی است، لطفاً بررسی کنید";
}

// Shown whenever lib/ai/parse-transaction.ts detected the text as buying a
// live-priced asset (gold/usd/bitcoin) - in both the inline live-preview
// card and the full preview stage, since either can be the one the user
// actually submits from (see saveTransaction's own comment on why the
// inline card is the primary path). Checked by default - unchecking it
// keeps the expense transaction but skips creating the matching Asset row,
// for when the AI got this wrong.
function AssetPurchaseNotice({
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

export function AddTransactionForm({
  categories: initialCategories,
  accounts: initialAccounts,
  defaultAccountId,
  editTransaction,
  initialTransaction,
  initialRawInput,
}: {
  categories: CategoryOption[];
  accounts: AccountOption[];
  defaultAccountId: number;
  editTransaction?: EditTransaction;
  // Pre-fills the preview/edit stage the same way editTransaction does, but
  // for a transaction that doesn't exist in the DB yet (e.g. the chat
  // assistant's suggest_transaction "ویرایش کن" handoff - see
  // components/chat/chat-interface.tsx). Deliberately a separate prop from
  // editTransaction: `isEdit` below (and therefore PATCH-vs-POST, the
  // cancel button's destination, "ذخیره تغییرات" vs "تأیید و ذخیره") stays
  // driven only by editTransaction, so a suggestion still goes through the
  // normal create path - it just skips the raw-text step.
  initialTransaction?: ParsedTransaction;
  initialRawInput?: string;
}) {
  const router = useRouter();
  const isEdit = Boolean(editTransaction);
  const isFromSuggestion = Boolean(initialTransaction);
  const [text, setText] = useState(initialRawInput ?? "");
  const [stage, setStage] = useState<Stage>(editTransaction || initialTransaction ? "preview" : "input");
  const [parsed, setParsed] = useState<ParsedTransaction | null>(editTransaction ?? initialTransaction ?? null);
  const [accounts, setAccounts] = useState<AccountOption[]>(initialAccounts);
  const [categories, setCategories] = useState<CategoryOption[]>(initialCategories);
  const [accountId, setAccountId] = useState<number>(editTransaction?.accountId ?? defaultAccountId);
  const [error, setError] = useState<string | null>(null);
  const [livePreview, setLivePreview] = useState<ParsedTransaction | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseLimitedUntil, setParseLimitedUntil] = useState<number | null>(null);
  const [liveCategoryExpanded, setLiveCategoryExpanded] = useState(false);
  const [isCreatingBankAccount, setIsCreatingBankAccount] = useState(false);
  const [createAccountError, setCreateAccountError] = useState<string | null>(null);
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [createCategoryError, setCreateCategoryError] = useState<string | null>(null);
  // Whether a detected asset purchase (AssetPurchaseNotice above) should
  // actually create the matching Asset row on submit - checked by default
  // whenever one is detected (see the two setIncludeAssetPurchase(true)
  // resets below, on a fresh parse / on dismissing the current attempt), so
  // this only ever needs to be un-checked, not turned on by hand.
  const [includeAssetPurchase, setIncludeAssetPurchase] = useState(true);

  const parseAbortControllerRef = useRef<AbortController | null>(null);
  // SEC-10 (docs/roadmap-status.md): idempotency key for the create request
  // below, generated once per submit *attempt* - not per render, and not
  // regenerated on a retry of that same attempt (a second saveTransaction()
  // call for the same pending transaction, e.g. the user clicking "تأیید و
  // ذخیره" again after a failed save, or a double-tap racing ahead of
  // React's state update). Reusing the same key means the server-side
  // check recognizes the retry and returns the already-created transaction
  // instead of a duplicate. Only reset in handleReset()/
  // handleDismissLivePreview() below - the points where the user actually
  // abandons this attempt and starts a new one.
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      parseAbortControllerRef.current?.abort();
    };
  }, []);

  async function handleProcess() {
    const trimmed = text.trim();
    if (trimmed.length < 4) return;
    if (parseLimitedUntil && Date.now() < parseLimitedUntil) return;

    parseAbortControllerRef.current?.abort();
    const controller = new AbortController();
    parseAbortControllerRef.current = controller;

    setIsParsing(true);
    try {
      const res = await fetch("/api/transactions/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const retryAfterSeconds =
          typeof data.retryAfterSeconds === "number" && data.retryAfterSeconds > 0 ? data.retryAfterSeconds : 60;
        setParseLimitedUntil(Date.now() + retryAfterSeconds * 1000);
        setLiveError(PARSE_RATE_LIMIT_MESSAGE);
        setLivePreview(null);
        return;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در پردازش متن.");
      setLivePreview(data.parsed);
      setLiveError(null);
      // A fresh parse result is a new asset-purchase attempt (if any) -
      // default back to included rather than carrying over a previous
      // attempt's un-check (see AssetPurchaseNotice's own comment).
      setIncludeAssetPurchase(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setLiveError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setLivePreview(null);
    } finally {
      // A re-click aborts the in-flight request and fires a new one; only let the
      // still-current controller's cleanup clear the spinner, otherwise the
      // superseded request's finally can hide it while the new one is still running.
      if (parseAbortControllerRef.current === controller) {
        setIsParsing(false);
      }
    }
  }

  // Shared by the full preview stage's confirm button, the inline
  // live-preview card's direct submit button, and "ثبت سریع" (quick
  // submit) below - all three promote a ParsedTransaction into `parsed` and
  // save it the same way. Takes the transaction explicitly rather than
  // reading `parsed` from state so the live-preview path can call this in
  // the same tick as setParsed() without racing React's async state update.
  //
  // `quick`: set only by handleQuickSubmit() - forwarded verbatim to POST
  // /api/transactions, where it marks the row for background AI
  // enrichment (see that route's own comment and lib/workflows/
  // enrich-transaction.ts). Not applicable to edits, same as the rest of
  // createPayload below.
  async function saveTransaction(transaction: ParsedTransaction, { quick = false }: { quick?: boolean } = {}) {
    setStage("saving");
    setError(null);
    // Not applicable to the PATCH/edit path - SEC-10 only covers creation
    // (see lib/data/transactions.ts's createTransaction()); generated
    // lazily so an edit never allocates one it doesn't use.
    if (!isEdit && !idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }

    // Offline queue (creation only - out of scope for edits, which have no
    // idempotency key to safely retry with; see lib/offline/
    // transaction-queue.ts's own comment). Built and written to IndexedDB
    // *before* the network attempt below, on every submit regardless of
    // actual connectivity - same code path online or offline, per this
    // task's own brief - so a tab closed right after this line still has
    // the item recorded when it reopens.
    // Explicit fields (not `...transaction`) - matches exactly what
    // POST /api/transactions actually reads (see its own body parsing),
    // so the stored queue payload and the request body are identical and
    // neither carries ParsedTransaction-only fields (`suggestedCategory`,
    // `confidence`, `bank`, ...) that the server would just ignore anyway.
    const createPayload = !isEdit
      ? {
          amount: transaction.amount,
          type: transaction.type,
          category: transaction.category,
          description: transaction.description,
          date: transaction.date,
          rawInput: text.trim(),
          accountId,
          idempotencyKey: idempotencyKeyRef.current!,
          ...(isFromSuggestion ? { source: "assistant-suggestion" as const } : {}),
          ...(quick ? { quick: true as const } : {}),
          ...(transaction.assetSuggestion && includeAssetPurchase
            ? {
                assetPurchase: {
                  type: transaction.assetSuggestion.type,
                  quantity: transaction.assetSuggestion.quantity,
                  purchasePricePerUnit: transaction.assetSuggestion.purchasePricePerUnit,
                },
              }
            : {}),
        }
      : null;
    if (createPayload) {
      try {
        await enqueueTransaction(createPayload);
      } catch {
        // IndexedDB unavailable (SSR/old browser/storage disabled) -
        // offline queuing is a progressive enhancement, same precedent as
        // ServiceWorkerRegister's own catch-and-ignore; the fetch below
        // still runs normally either way.
      }
    }

    try {
      let res: Response;
      try {
        res = isEdit
          ? await fetch(`/api/transactions/${editTransaction!.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                amount: transaction.amount,
                type: transaction.type,
                category: transaction.category,
                description: transaction.description,
                date: transaction.date,
                accountId,
              }),
            })
          : await fetch("/api/transactions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(createPayload),
            });
      } catch (networkErr) {
        // No queued fallback for edits - same error handling as before.
        if (!createPayload) throw networkErr;
        // No connectivity: the "pending" row written above stays queued;
        // OfflineSyncRegister's `online` listener (via
        // lib/offline/sync-transactions.ts) retries it automatically once
        // the browser reconnects, reusing this same idempotencyKey. From
        // the user's point of view this submit succeeded (optimistically) -
        // navigate to the transactions list, where the queued item is
        // already visible as pending, instead of showing an error.
        router.push("/app/transactions");
        return;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || (isEdit ? "خطا در ذخیره تغییرات." : "خطا در ذخیره تراکنش."));

      if (createPayload) {
        // Server-confirmed create - the queued row's job is done. Best-
        // effort: a failed cleanup here isn't user-visible (the pending
        // list only shows non-"synced" rows) and would just be a harmless
        // no-op the next time anything touches this key.
        deleteQueuedTransaction(createPayload.idempotencyKey).catch(() => {});
      }

      router.push(isEdit ? "/app/transactions" : "/app");
      router.refresh();
    } catch (err) {
      if (createPayload) {
        // A real server-side rejection (validation/auth), not a
        // connectivity failure - that's handled above, before this catch
        // is reached. The inline error below already tells the user what's
        // wrong on this exact screen, so there's nothing left for the
        // offline queue to retry - remove the row instead of leaving a
        // ghost "failed" entry for something already being corrected here.
        deleteQueuedTransaction(createPayload.idempotencyKey).catch(() => {});
      }
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setStage("preview");
      // idempotencyKeyRef deliberately NOT cleared here - see its own
      // comment. A retry of this exact attempt (clicking "تأیید و ذخیره"
      // again) must reuse the same key.
    }
  }

  function handleConfirm() {
    if (!parsed) return;
    saveTransaction(parsed);
  }

  // "ثبت سریع" - saves instantly from the raw textarea text with no AI
  // call at all, using the same deterministic extractors the AI's own fast
  // path already relies on (lib/extract-amount.ts, lib/extract-date.ts -
  // see lib/ai/parse-transaction.ts's merchant-match branch). type/category
  // can't be guessed deterministically, so they default to "expense" /
  // FALLBACK_EXPENSE_CATEGORY, same defaults the AI prompt itself falls
  // back to when the text doesn't say otherwise - the background workflow
  // (lib/workflows/enrich-transaction.ts) refines both once it runs.
  // amount is guaranteed non-null here because the button below is disabled
  // whenever it isn't.
  function handleQuickSubmit() {
    const trimmed = text.trim();
    const amount = extractAmount(trimmed);
    if (!amount) return;

    const quickParsed: ParsedTransaction = {
      amount,
      type: "expense",
      category: FALLBACK_EXPENSE_CATEGORY,
      description: trimmed.slice(0, 40),
      date: extractDate(trimmed) ?? new Date().toISOString().slice(0, 10),
    };
    setParsed(quickParsed);
    saveTransaction(quickParsed, { quick: true });
  }

  function handleSubmitLivePreview() {
    if (!livePreview) return;
    setParsed(livePreview);
    saveTransaction(livePreview);
  }

  function handleDismissLivePreview() {
    parseAbortControllerRef.current?.abort();
    setText("");
    setLivePreview(null);
    setLiveError(null);
    setLiveCategoryExpanded(false);
    setCreateAccountError(null);
    setIncludeAssetPurchase(true);
    // A new attempt starts from here (different/cleared text) - SEC-10's
    // idempotency key must not carry over to it.
    idempotencyKeyRef.current = null;
  }

  function handleReset() {
    setParsed(null);
    setError(null);
    setCreateAccountError(null);
    setCreateCategoryError(null);
    setIncludeAssetPurchase(true);
    setStage("input");
    // Same reasoning as handleDismissLivePreview() above - "ویرایش متن"
    // sends the user back to edit the raw text, so whatever they submit
    // next is a new attempt, not a retry of this one.
    idempotencyKeyRef.current = null;
  }

  async function handleCreateBankAccount(name: string) {
    setIsCreatingBankAccount(true);
    setCreateAccountError(null);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type: "bank", initialBalance: 0 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ساخت حساب.");
      setAccounts((prev) => [...prev, data.account]);
      setAccountId(data.account.id);
    } catch (err) {
      setCreateAccountError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
    } finally {
      setIsCreatingBankAccount(false);
    }
  }

  // `target` picks which piece of state the resolved category gets written back
  // to - the full preview stage's `parsed`, or the inline live-preview card's
  // `livePreview`. Defaults to "parsed" so the existing call site below is unchanged.
  async function handleCreateCategory(
    suggestion: SuggestedCategoryWithIcon,
    type: CategoryType,
    target: "parsed" | "livePreview" = "parsed"
  ) {
    setIsCreatingCategory(true);
    setCreateCategoryError(null);
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
      // 200 (resolvedExisting) can return a category already in local state - dedupe on id
      // so the <select> below never renders two <option>s with the same key/value.
      setCategories((prev) => (prev.some((c) => c.id === data.category.id) ? prev : [...prev, data.category]));
      // Functional update (unlike the direct-closure `setParsed({ ...parsed, ... })` calls
      // elsewhere in this file) because this fires after an await - `parsed`/`livePreview`
      // may have moved on (e.g. the user edited amount/description while the request was
      // in flight).
      const applyResolvedCategory = (prev: ParsedTransaction | null) =>
        prev ? { ...prev, category: data.category.name, suggestedCategory: undefined } : prev;
      if (target === "livePreview") {
        setLivePreview(applyResolvedCategory);
      } else {
        setParsed(applyResolvedCategory);
      }
    } catch (err) {
      setCreateCategoryError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
    } finally {
      setIsCreatingCategory(false);
    }
  }

  const availableCategories = categories.filter((c) => c.type === parsed?.type);
  const showLiveResult = text.trim().length >= 4;
  // Exact-match against the label handleCreateBankAccount creates the account with,
  // so this naturally stops matching (and the prompt disappears) once that account exists.
  const missingBankAccountLabel = getMissingBankAccountLabel(parsed, accounts);
  const liveMissingBankAccountLabel = getMissingBankAccountLabel(livePreview, accounts);
  const suggestedCategory = parsed?.suggestedCategory ?? null;

  return (
    <div className="flex h-full flex-col px-4 pb-6 pt-6">
      <h1 className="text-lg font-bold text-foreground">{isEdit ? "ویرایش تراکنش" : "افزودن تراکنش"}</h1>
      <p className="mt-1 text-sm text-muted">
        {isEdit
          ? "جزئیات تراکنش را ویرایش کن و ذخیره کن."
          : "تراکنش را به زبان طبیعی بنویس، هوش مصنوعی جزئیات را استخراج می‌کند."}
      </p>

      {stage === "input" ? (
        <div className="mt-6 flex flex-col gap-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="مثلاً: ۵۰ هزار تومن ناهار خوردم"
            rows={4}
            className="w-full resize-none rounded-2xl border border-border bg-surface p-4 text-sm text-foreground outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleProcess}
              disabled={!showLiveResult}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary disabled:opacity-50"
            >
              پردازش
            </button>
            {/* Disabled whenever the text has no deterministically-extractable
                amount (lib/extract-amount.ts) - handleQuickSubmit relies on
                that same extraction succeeding, so this is real feedback, not
                just a style cue: if this is disabled, "پردازش" (the AI path)
                is the only way to save this particular text. */}
            <button
              type="button"
              onClick={handleQuickSubmit}
              disabled={!extractAmount(text.trim())}
              title="ثبت فوری بدون تحلیل هوش مصنوعی - دسته‌بندی بعداً خودکار تکمیل می‌شود"
              className="flex shrink-0 items-center justify-center gap-1.5 rounded-2xl border border-accent px-4 py-3.5 text-sm font-semibold text-accent disabled:opacity-50"
            >
              <ZapIcon className="h-4 w-4" />
              ثبت سریع
            </button>
          </div>
          {showLiveResult && isParsing && !livePreview && !liveError && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
              در حال پردازش...
            </p>
          )}
          {showLiveResult &&
            livePreview &&
            (() => {
              const liveCategories = categories.filter((c) => c.type === livePreview.type);
              const liveSuggestedCategory = livePreview.suggestedCategory ?? null;
              return (
                <div className="rounded-2xl border border-border bg-surface p-4">
                  <p className="text-xs text-muted">پیش‌نمایش هوش مصنوعی — قابل ویرایش</p>

                  <div className="mt-2 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={handleDismissLivePreview}
                      aria-label="بستن"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background text-muted transition-colors hover:text-foreground"
                    >
                      <XIcon className="h-4 w-4" />
                    </button>
                    <p className="truncate text-sm font-semibold text-foreground">
                      {livePreview.description} {formatToman(livePreview.amount)}
                    </p>
                  </div>

                  <div className="mt-3 flex gap-2">
                    {(["expense", "income"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() =>
                          setLivePreview({
                            ...livePreview,
                            type: t,
                            category: categories.find((c) => c.type === t)?.name ?? livePreview.category,
                          })
                        }
                        className={`flex-1 rounded-xl py-2 text-sm font-medium transition-colors ${
                          livePreview.type === t ? "bg-primary text-on-primary" : "bg-background text-muted"
                        }`}
                      >
                        {t === "income" ? "درآمد" : "هزینه"}
                      </button>
                    ))}
                  </div>

                  <label className="mt-4 block text-xs text-muted">مبلغ (تومان)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={formatNumber(livePreview.amount)}
                    onChange={(e) => {
                      const digits = toLatinDigits(e.target.value).replace(/[^0-9]/g, "");
                      setLivePreview({ ...livePreview, amount: digits ? Number(digits) : 0 });
                    }}
                    className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
                  />

                  <label className="mt-4 block text-xs text-muted">دسته‌بندی</label>
                  {liveCategoryExpanded ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {liveCategories.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setLivePreview({ ...livePreview, category: c.name })}
                          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                            livePreview.category === c.name
                              ? "bg-primary text-on-primary"
                              : "border border-border bg-background text-muted"
                          }`}
                        >
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                          {c.name}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setLiveCategoryExpanded(false)}
                        className="text-xs text-accent"
                      >
                        بستن
                      </button>
                    </div>
                  ) : (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {(() => {
                        const selectedCategory = liveCategories.find((c) => c.name === livePreview.category);
                        if (!selectedCategory) return null;
                        return (
                          <span className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-on-primary">
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: selectedCategory.color }}
                            />
                            {selectedCategory.name}
                          </span>
                        );
                      })()}
                      <button
                        type="button"
                        onClick={() => setLiveCategoryExpanded(true)}
                        className="text-xs text-accent"
                      >
                        بیشتر
                      </button>
                    </div>
                  )}

                  {liveSuggestedCategory && (
                    <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-accent/10 px-3 py-2">
                      <p className="text-xs text-accent">
                        دسته‌بندی «{liveSuggestedCategory.icon} {liveSuggestedCategory.name}» براش پیدا نشد — می‌خوای
                        بسازمش؟
                      </p>
                      <button
                        type="button"
                        onClick={() => handleCreateCategory(liveSuggestedCategory, livePreview.type, "livePreview")}
                        disabled={isCreatingCategory}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
                      >
                        {isCreatingCategory && <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
                        بساز
                      </button>
                    </div>
                  )}
                  {createCategoryError && <p className="mt-1.5 text-xs text-warning">{createCategoryError}</p>}

                  {livePreview.assetSuggestion && (
                    <AssetPurchaseNotice
                      assetSuggestion={livePreview.assetSuggestion}
                      included={includeAssetPurchase}
                      onToggle={setIncludeAssetPurchase}
                    />
                  )}

                  {liveMissingBankAccountLabel && (
                    <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-accent/10 px-3 py-2">
                      <p className="text-xs text-accent">
                        حساب {liveMissingBankAccountLabel} پیدا نشد — می‌خواهید بسازید؟
                      </p>
                      <button
                        type="button"
                        onClick={() => handleCreateBankAccount(liveMissingBankAccountLabel)}
                        disabled={isCreatingBankAccount}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
                      >
                        {isCreatingBankAccount && <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
                        ساخت حساب
                      </button>
                    </div>
                  )}
                  {createAccountError && <p className="mt-1.5 text-xs text-warning">{createAccountError}</p>}

                  {/* Saving/error state surfaces via the full preview stage below - saveTransaction()
                      moves `stage` off "input" in the same batch as this click, so this card
                      unmounts before any loading state of its own would be visible. */}
                  <button
                    type="button"
                    onClick={handleSubmitLivePreview}
                    disabled={isCreatingBankAccount || isCreatingCategory}
                    className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary disabled:opacity-50"
                  >
                    ثبت تراکنش
                  </button>
                </div>
              );
            })()}
          {showLiveResult && liveError && <p className="text-xs text-warning">{liveError}</p>}
          {error && <p className="text-sm text-warning">{error}</p>}
        </div>
      ) : (
        parsed && (
          <div className="mt-6 flex flex-col gap-4">
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="text-xs text-muted">پیش‌نمایش تراکنش</p>

              {parsed.source === "bank-sms" && parsed.bank && parsed.bank !== "unknown" && (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent">
                  <ChatIcon className="h-3.5 w-3.5" />
                  پیامک بانکی · {getBankLabel(parsed.bank)}
                </div>
              )}

              <div className="mt-3 flex gap-2">
                {(["expense", "income"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      setParsed({
                        ...parsed,
                        type: t,
                        category: categories.find((c) => c.type === t)?.name ?? parsed.category,
                      })
                    }
                    className={`flex-1 rounded-xl py-2 text-sm font-medium transition-colors ${
                      parsed.type === t
                        ? t === "income"
                          ? "bg-success text-white"
                          : "bg-warning text-white"
                        : "bg-background text-muted"
                    }`}
                  >
                    {t === "income" ? "درآمد" : "هزینه"}
                  </button>
                ))}
              </div>

              <label className="mt-4 block text-xs text-muted">مبلغ (تومان)</label>
              <input
                type="number"
                value={parsed.amount}
                onChange={(e) => setParsed({ ...parsed, amount: Number(e.target.value) })}
                className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
              />

              <label className="mt-4 block text-xs text-muted">دسته‌بندی</label>
              <select
                value={parsed.category}
                onChange={(e) => setParsed({ ...parsed, category: e.target.value })}
                className={`mt-1 w-full rounded-xl border bg-background p-3 text-sm outline-none focus:border-accent ${
                  parsed.source === "bank-sms" ? "border-warning" : "border-border"
                }`}
              >
                {availableCategories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.icon} {c.name}
                  </option>
                ))}
              </select>
              {parsed.needsConfirmation && (
                <p className="mt-1.5 text-xs text-warning">
                  {getConfirmationHintText(parsed)}
                </p>
              )}
              {suggestedCategory && (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-accent/10 px-3 py-2">
                  <p className="text-xs text-accent">
                    دسته‌بندی «{suggestedCategory.icon} {suggestedCategory.name}» براش پیدا نشد — می‌خوای بسازمش؟
                  </p>
                  <button
                    type="button"
                    onClick={() => handleCreateCategory(suggestedCategory, parsed.type)}
                    disabled={isCreatingCategory}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
                  >
                    {isCreatingCategory && <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
                    بساز
                  </button>
                </div>
              )}
              {createCategoryError && <p className="mt-1.5 text-xs text-warning">{createCategoryError}</p>}

              <label className="mt-4 block text-xs text-muted">حساب</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(Number(e.target.value))}
                className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {getAccountTypeIcon(a.type)} {a.name}
                  </option>
                ))}
              </select>
              {missingBankAccountLabel && (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-accent/10 px-3 py-2">
                  <p className="text-xs text-accent">حساب {missingBankAccountLabel} پیدا نشد — می‌خواهید بسازید؟</p>
                  <button
                    type="button"
                    onClick={() => handleCreateBankAccount(missingBankAccountLabel)}
                    disabled={isCreatingBankAccount}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
                  >
                    {isCreatingBankAccount && <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
                    ساخت حساب
                  </button>
                </div>
              )}
              {createAccountError && <p className="mt-1.5 text-xs text-warning">{createAccountError}</p>}

              {parsed.assetSuggestion && (
                <AssetPurchaseNotice
                  assetSuggestion={parsed.assetSuggestion}
                  included={includeAssetPurchase}
                  onToggle={setIncludeAssetPurchase}
                />
              )}

              <label className="mt-4 block text-xs text-muted">توضیح</label>
              <input
                type="text"
                value={parsed.description}
                onChange={(e) => setParsed({ ...parsed, description: e.target.value })}
                className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
              />

              <label className="mt-4 block text-xs text-muted">
                تاریخ ({formatJalaaliDate(parsed.date)})
              </label>
              <input
                type="date"
                value={parsed.date}
                onChange={(e) => setParsed({ ...parsed, date: e.target.value })}
                className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
              />

              <div className="mt-4 rounded-xl bg-background p-3 text-center">
                <p className="text-xs text-muted">مبلغ نهایی</p>
                <p
                  className={`text-xl font-bold tabular-fa ${
                    parsed.type === "income" ? "text-success" : "text-warning"
                  }`}
                >
                  {formatToman(parsed.amount)}
                </p>
              </div>
            </div>

            {error && <p className="text-sm text-warning">{error}</p>}

            <div className="flex gap-3">
              <button
                onClick={isEdit ? () => router.push("/app/transactions") : handleReset}
                disabled={stage === "saving"}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-border py-3.5 text-sm font-semibold text-foreground disabled:opacity-50"
              >
                <XIcon className="h-4 w-4" />
                {isEdit ? "انصراف" : "ویرایش متن"}
              </button>
              <button
                onClick={handleConfirm}
                disabled={stage === "saving" || isCreatingBankAccount || isCreatingCategory}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary disabled:opacity-50"
              >
                {stage === "saving" ? (
                  <SpinnerIcon className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckIcon className="h-4 w-4" />
                )}
                {isEdit ? "ذخیره تغییرات" : "تأیید و ذخیره"}
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
