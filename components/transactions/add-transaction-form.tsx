"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  EditIcon,
  SparklesIcon,
  SpinnerIcon,
  XIcon,
  ZapIcon,
} from "@/components/icons";
import { formatToman } from "@/lib/format";
import { AmountInput } from "@/components/ui/amount-input";
import { NaturalLanguageAmountTextarea } from "@/components/ui/natural-language-amount-textarea";
import type { ParsedTransaction, SuggestedCategoryWithIcon } from "@/lib/ai/parse-transaction";
import { getBankLabel } from "@/lib/bank/labels";
import { getAccountTypeIcon, type AccountOption } from "@/lib/accounts";
import { FALLBACK_EXPENSE_CATEGORY, FALLBACK_INCOME_CATEGORY, type CategoryType } from "@/lib/categories";
import { extractAmount } from "@/lib/extract-amount";
import { extractDate, tehranIsoDate } from "@/lib/extract-date";
import { extractIncomeSignal } from "@/lib/extract-transaction-type";
import { parseBankSms } from "@/lib/bank/parse-bank-sms";
import { normalizeText as normalizeBankSmsText } from "@/lib/bank/normalize";
import {
  type CategoryOption,
  type CreateTransactionPayload,
  getMissingBankAccountLabel,
  getConfirmationHintText,
  isSelectableCategory,
  AssetPurchaseNotice,
  submitCreateBankAccount,
  submitCreateCategory,
  submitCreateTransaction,
} from "@/components/transactions/transaction-form-shared";
import { BatchAddTransactionForm } from "@/components/transactions/batch-add-transaction-form";
import { JalaliDatePicker } from "@/components/goals/jalali-date-picker";

export type { CategoryOption };

// Plain calendar-day offsets from today - unlike JalaliDatePicker's default
// "۱/۳/۶ ماه" options (Jalali-month arithmetic, meant for a goal deadline),
// a transaction date only ever needs "today or a couple of days back".
// "Today" is Tehran's (tehranIsoDate), same as the quick-submit default
// below and the server-side AI parse - not the browser's own day.
const TRANSACTION_DAY_OFFSETS = [
  ["امروز", 0],
  ["دیروز", -1],
  ["پریروز", -2],
] as const;

const TRANSACTION_QUICK_SELECT_OPTIONS = TRANSACTION_DAY_OFFSETS.map(([label, offsetDays]) => ({
  label,
  // The picker reads the returned Date's local y/m/d fields, so it gets the
  // Tehran day as a local midnight.
  getDate: (now: Date) => {
    const [y, m, d] = tehranIsoDate(now, offsetDays).split("-").map(Number);
    return new Date(y, m - 1, d);
  },
}));

// Best-effort deterministic guess for handleQuickSubmit/the "ثبت تراکنش"
// button's disabled state, given the trimmed textarea text. Tries
// extractAmount first, unchanged from before - ordinary typed text
// ("۵۰ هزار تومن قهوه") still resolves exactly as it always has. Only when
// that fails does it fall back to parseBankSms, which handles the shape a
// real pasted bank SMS actually has (several numeric tokens - amount,
// balance, account digits, date/time - which extractAmount's "exactly one
// or two numbers" rule always rejects). Returns null (button stays
// disabled) when neither resolves.
//
// type/category on the extractAmount branch default to "expense" /
// FALLBACK_EXPENSE_CATEGORY - ordinary typed text can't be classified
// deterministically in general - with one deliberately narrow exception:
// extractIncomeSignal (lib/extract-transaction-type.ts) flips both to
// "income" / FALLBACK_INCOME_CATEGORY when the text contains an
// unambiguous income keyword such as "حقوق". category must always track
// type (an income transaction under an expense category is an invalid
// pair), hence one signal drives both. The parseBankSms branch has its own
// type detection and never consults extractIncomeSignal.
function buildQuickParsedTransaction(trimmed: string, dateOverride?: string): ParsedTransaction | null {
  const amount = extractAmount(trimmed);
  if (amount) {
    const isIncome = extractIncomeSignal(trimmed);
    return {
      amount,
      type: isIncome ? "income" : "expense",
      category: isIncome ? FALLBACK_INCOME_CATEGORY : FALLBACK_EXPENSE_CATEGORY,
      description: trimmed.slice(0, 40),
      date: dateOverride ?? extractDate(trimmed) ?? tehranIsoDate(),
    };
  }

  const bankResult = parseBankSms(trimmed);
  if (!bankResult) return null;

  return {
    amount: bankResult.amount,
    type: bankResult.type,
    category: bankResult.type === "income" ? FALLBACK_INCOME_CATEGORY : FALLBACK_EXPENSE_CATEGORY,
    // Same normalize-then-slice(0, 40) convention lib/ai/parse-transaction.ts's
    // buildBankSmsResult uses for a bank-sms description.
    description: normalizeBankSmsText(trimmed).slice(0, 40),
    date: dateOverride ?? bankResult.date,
  };
}

// "امروز"/"دیروز"/"پریروز" next to the picked date, so the common case reads
// at a glance without decoding a Jalali date. Same offsets as the picker's
// own quick-select buttons above.
function relativeDayLabel(value: string): string | null {
  const now = new Date();
  return TRANSACTION_DAY_OFFSETS.find(([, offsetDays]) => tehranIsoDate(now, offsetDays) === value)?.[0] ?? null;
}

function DateField({ value, onChange, fieldClassName }: { value: string; onChange: (value: string) => void; fieldClassName: string }) {
  const relative = relativeDayLabel(value);
  return (
    <div className="relative">
      <JalaliDatePicker
        value={value}
        onChange={onChange}
        triggerClassName={`w-full rounded-xl border border-border py-3 ps-10 pe-4 text-start text-sm tabular-fa text-foreground outline-none transition-colors focus-visible:border-accent ${fieldClassName}`}
        showDeadlineCountdown={false}
        density="compact"
        quickSelectOptions={TRANSACTION_QUICK_SELECT_OPTIONS}
      />
      {/* The picker's panel is absolutely positioned, so this wrapper is
          exactly the trigger's height and top-1/2 centers on it. */}
      <CalendarIcon className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      {relative && (
        <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 rounded-full bg-foreground/10 px-2.5 py-0.5 text-[11px] font-medium text-muted">
          {relative}
        </span>
      )}
    </div>
  );
}

// Native <select> kept on purpose (the OS picker is the right control on a
// phone), with the browser's arrow swapped for the app's own chevron - same
// treatment as transaction-filter-bar.tsx's FilterSelect.
function SelectField({
  id,
  value,
  onChange,
  highlighted = false,
  children,
}: {
  id: string;
  value: string | number;
  onChange: (value: string) => void;
  highlighted?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="relative mt-1.5">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full cursor-pointer appearance-none truncate rounded-xl border bg-background py-3 ps-3.5 pe-10 text-sm text-foreground outline-none transition-colors focus:border-accent ${
          highlighted ? "border-warning" : "border-border"
        }`}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute inset-y-0 end-3.5 my-auto h-4 w-4 text-muted" />
    </div>
  );
}

const FIELD_LABEL_CLASS = "block text-xs font-medium text-muted";

// A save in flight keeps the button gold (with its spinner) instead of
// greying it out like a "can't submit yet" button - busy isn't unavailable.
function primaryButtonClass(busy: boolean): string {
  return `flex items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary transition-[background-color,color,scale] motion-reduce:transition-none ${
    busy
      ? "cursor-wait opacity-80"
      : "active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted disabled:active:scale-100"
  }`;
}

interface EditTransaction extends Pick<ParsedTransaction, "amount" | "type" | "category" | "description" | "date"> {
  id: number;
  accountId: number;
}

type Stage = "input" | "preview" | "saving";

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
  const [isCreatingBankAccount, setIsCreatingBankAccount] = useState(false);
  const [createAccountError, setCreateAccountError] = useState<string | null>(null);
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [createCategoryError, setCreateCategoryError] = useState<string | null>(null);
  // Whether a detected asset purchase (AssetPurchaseNotice above) should
  // actually create the matching Asset row on submit - checked by default
  // whenever one is detected (see handleReset()'s own setIncludeAssetPurchase(true)),
  // so this only ever needs to be un-checked, not turned on by hand.
  const [includeAssetPurchase, setIncludeAssetPurchase] = useState(true);
  // Batch mode (up to 5 lines at once) - only offered on the fresh "add"
  // flow (see the toggle's own render condition below), never in edit mode
  // or the from-suggestion handoff, both of which already have a single,
  // specific transaction to work with. categories/accounts/accountId state
  // above stays shared between single and batch mode (one account picker,
  // one growing category list) rather than each owning a duplicate copy -
  // switching modes never loses a category/account created moments ago.
  const [mode, setMode] = useState<"single" | "batch">("single");

  // Explicit date override for the "input" stage's quick-submit path -
  // null means "not touched, keep auto-detecting from text" (extractDate/
  // parseBankSms's date, same as before this field existed); once the user
  // picks a date via the input-stage date field below, that value wins
  // instead. Reset in handleReset() same lifecycle as idempotencyKeyRef/
  // includeAssetPurchase above.
  const [manualDate, setManualDate] = useState<string | null>(null);

  // A quick submit ("ثبت تراکنش") stays on the input stage while its request
  // is in flight - spinner on its own button - instead of going through
  // stage "saving", which renders the full preview form. That form used to
  // flash up for the second or two the save took, fully populated with the
  // quick-parse guesses, right before navigating away. The preview stage
  // still appears if the save fails, since then there's something to fix.
  const [isQuickSaving, setIsQuickSaving] = useState(false);

  const fieldIds = useId();

  // SEC-10 (docs/roadmap-status.md): idempotency key for the create request
  // below, generated once per submit *attempt* - not per render, and not
  // regenerated on a retry of that same attempt (a second saveTransaction()
  // call for the same pending transaction, e.g. the user clicking "تأیید و
  // ذخیره" again after a failed save, or a double-tap racing ahead of
  // React's state update). Reusing the same key means the server-side
  // check recognizes the retry and returns the already-created transaction
  // instead of a duplicate. Only reset in handleReset() below - the point
  // where the user actually abandons this attempt and starts a new one.
  const idempotencyKeyRef = useRef<string | null>(null);

  // Shared by the full preview stage's confirm button and "ثبت تراکنش"
  // (quick submit) below - both promote a ParsedTransaction into `parsed`
  // and save it the same way. Takes the transaction explicitly rather than
  // reading `parsed` from state so callers can do so in the same tick as
  // setParsed() without racing React's async state update.
  //
  // `quick`: set only by handleQuickSubmit() - forwarded verbatim to POST
  // /api/transactions, where it marks the row for background AI
  // enrichment (see that route's own comment and lib/workflows/
  // enrich-transaction.ts). Not applicable to edits, same as the rest of
  // createPayload below.
  async function saveTransaction(transaction: ParsedTransaction, { quick = false }: { quick?: boolean } = {}) {
    if (quick) {
      setIsQuickSaving(true);
    } else {
      setStage("saving");
    }
    setError(null);

    // Edits never go through the offline queue (no idempotency key to
    // safely retry with - see lib/offline/transaction-queue.ts's own
    // comment) and use PATCH, not submitCreateTransaction's POST - kept
    // fully separate from the create path below.
    if (isEdit) {
      try {
        const res = await fetch(`/api/transactions/${editTransaction!.id}`, {
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
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "تغییرات ذخیره نشد، دوباره تلاش کن.");
        router.push("/app/transactions");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "یه مشکلی پیش اومد، دوباره تلاش کن.");
        setStage("preview");
      }
      return;
    }

    // SEC-10: generated lazily, once per submit *attempt* - not per render,
    // and not regenerated on a retry of that same attempt (see this ref's
    // own top-of-file comment).
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }

    // Explicit fields (not `...transaction`) - matches exactly what
    // POST /api/transactions actually reads (see its own body parsing), so
    // the stored queue payload and the request body are identical and
    // neither carries ParsedTransaction-only fields (`suggestedCategory`,
    // `confidence`, `bank`, ...) that the server would just ignore anyway.
    const createPayload: CreateTransactionPayload = {
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
      ...(quick && manualDate !== null ? { dateIsManual: true as const } : {}),
      ...(transaction.assetSuggestion && includeAssetPurchase
        ? {
            assetPurchase: {
              type: transaction.assetSuggestion.type,
              quantity: transaction.assetSuggestion.quantity,
              purchasePricePerUnit: transaction.assetSuggestion.purchasePricePerUnit,
            },
          }
        : {}),
    };

    const result = await submitCreateTransaction(createPayload);
    if (result.status === "queued") {
      // From the user's point of view this submit succeeded (optimistically) -
      // navigate to the transactions list, where the queued item is already
      // visible as pending, instead of showing an error.
      router.push("/app/transactions");
      return;
    }
    if (result.status === "error") {
      setError(result.message);
      setIsQuickSaving(false);
      setStage("preview");
      // idempotencyKeyRef deliberately NOT cleared here - see its own
      // comment. A retry of this exact attempt (clicking "تأیید و ذخیره"
      // again) must reuse the same key.
      return;
    }

    router.push("/app");
    router.refresh();
  }

  function handleConfirm() {
    if (!parsed) return;
    saveTransaction(parsed);
  }

  // "ثبت تراکنش" (still "quick submit" internally - see schema.prisma's
  // Transaction.enrichmentStatus) - saves instantly from the raw textarea
  // text with no synchronous AI call at all, using the same deterministic
  // extractors the AI's own fast path already relies on
  // (lib/extract-amount.ts, lib/extract-date.ts, and - for a pasted bank
  // SMS extractAmount can't handle - lib/bank/parse-bank-sms.ts; see
  // buildQuickParsedTransaction above). type/category can't be guessed
  // deterministically for ordinary typed text in general, so they default to
  // "expense" / FALLBACK_EXPENSE_CATEGORY, same defaults the AI prompt
  // itself falls back to when the text doesn't say otherwise - the one
  // narrow exception is an unambiguous income keyword (see
  // extractIncomeSignal), which yields "income" / FALLBACK_INCOME_CATEGORY
  // instead. The background workflow (lib/workflows/enrich-transaction.ts)
  // refines both once it runs. quickParsed is guaranteed non-null here because the
  // button below is disabled whenever buildQuickParsedTransaction returns
  // null.
  function handleQuickSubmit() {
    if (isQuickSaving) return;
    const trimmed = text.trim();
    const quickParsed = buildQuickParsedTransaction(trimmed, manualDate ?? undefined);
    if (!quickParsed) return;

    setParsed(quickParsed);
    saveTransaction(quickParsed, { quick: true });
  }

  function handleReset() {
    setParsed(null);
    setError(null);
    setCreateAccountError(null);
    setCreateCategoryError(null);
    setIncludeAssetPurchase(true);
    setManualDate(null);
    setStage("input");
    // "ویرایش متن" sends the user back to edit the raw text, so whatever
    // they submit next is a new attempt, not a retry of this one - SEC-10's
    // idempotency key must not carry over to it.
    idempotencyKeyRef.current = null;
  }

  async function handleCreateBankAccount(name: string) {
    setIsCreatingBankAccount(true);
    setCreateAccountError(null);
    const result = await submitCreateBankAccount(name);
    if ("error" in result) {
      setCreateAccountError(result.error);
    } else {
      setAccounts((prev) => [...prev, result.account]);
      setAccountId(result.account.id);
    }
    setIsCreatingBankAccount(false);
  }

  async function handleCreateCategory(suggestion: SuggestedCategoryWithIcon, type: CategoryType) {
    setIsCreatingCategory(true);
    setCreateCategoryError(null);
    const result = await submitCreateCategory(suggestion, type);
    if ("error" in result) {
      setCreateCategoryError(result.error);
    } else {
      // 200 (resolvedExisting) can return a category already in local state - dedupe on id
      // so the <select> below never renders two <option>s with the same key/value.
      setCategories((prev) => (prev.some((c) => c.id === result.category.id) ? prev : [...prev, result.category]));
      // Functional update (unlike the direct-closure `setParsed({ ...parsed, ... })` calls
      // elsewhere in this file) because this fires after an await - `parsed` may have moved
      // on (e.g. the user edited amount/description while the request was in flight).
      setParsed((prev) => (prev ? { ...prev, category: result.category.name, suggestedCategory: undefined } : prev));
    }
    setIsCreatingCategory(false);
  }

  const availableCategories = categories.filter((c) => isSelectableCategory(c, parsed?.type, parsed?.category));
  // Exact-match against the label handleCreateBankAccount creates the account with,
  // so this naturally stops matching (and the prompt disappears) once that account exists.
  const missingBankAccountLabel = getMissingBankAccountLabel(parsed, accounts);
  const suggestedCategory = parsed?.suggestedCategory ?? null;
  // Nudges toward /app/transfer (paired isTransfer-excluded transactions)
  // whenever the selected account is a savings account - a plain expense/
  // income here against a savings account is still structurally correct
  // (it's really the user's own money moving, not spending/earning), but
  // counting it as one silently overstates monthIncome/monthExpense on the
  // dashboard. Hint only, not enforced - see this field's own account
  // <select> below for why nothing about submission changes.
  const selectedAccount = accounts.find((a) => a.id === accountId);
  const isSavingsAccountSelected = selectedAccount?.type === "savings";

  const isFreshAdd = !isEdit && !isFromSuggestion;
  const subtitle = isEdit
    ? "جزئیات تراکنش را ویرایش کن و ذخیره کن."
    : stage !== "input"
      ? "جزئیات را بررسی کن و اگر لازم بود تغییر بده."
      : mode === "batch"
        ? "هر ردیف یک تراکنش؛ تا ۵ تراکنش را یک‌جا ثبت کن."
        : "تراکنش را به زبان طبیعی بنویس، هوش مصنوعی جزئیات را استخراج می‌کند.";

  // Pinned to the bottom of the scroll area (and pushed there by mt-auto
  // when the page is short), so the save button sits in thumb reach and
  // never needs a scroll to the end of the preview form to find. The
  // gradient fades content out underneath it instead of a hard edge.
  const stickyFooterClass =
    "sticky bottom-0 z-10 -mx-4 mt-auto bg-linear-to-t from-background from-70% to-transparent px-4 pb-4 pt-6";

  return (
    <div className="flex min-h-full flex-col px-4 pt-6">
      <header>
        <h1 className="text-lg font-bold text-foreground">{isEdit ? "ویرایش تراکنش" : "افزودن تراکنش"}</h1>
        <p className="mt-1 text-sm leading-6 text-muted">{subtitle}</p>
      </header>

      {/* Batch mode toggle - only on the fresh "add" flow (see this
          component's own `mode` state comment), and only before anything's
          been parsed yet - switching back to single mode mid-parse isn't a
          state this toggle needs to handle since it's hidden once stage
          leaves "input". */}
      {stage === "input" && isFreshAdd && (
        <div className="mt-5 grid grid-cols-2 gap-1 rounded-xl bg-surface p-1">
          {(
            [
              ["single", "تکی"],
              ["batch", "چندتایی"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              disabled={isQuickSaving}
              className={`rounded-lg py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                mode === value ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {stage === "input" && mode === "batch" && isFreshAdd ? (
        <div className="pb-6">
          <BatchAddTransactionForm
            categories={categories}
            accounts={accounts}
            accountId={accountId}
            onAccountIdChange={setAccountId}
            onCategoriesChange={setCategories}
            onAccountsChange={setAccounts}
          />
        </div>
      ) : stage === "input" ? (
        (() => {
          const trimmed = text.trim();
          const quickParsed = buildQuickParsedTransaction(trimmed, manualDate ?? undefined);
          const dateValue = manualDate ?? quickParsed?.date ?? tehranIsoDate();
          const hintId = `${fieldIds}-hint`;
          return (
            <div className="mt-4 flex flex-1 flex-col">
              <div className="flex flex-col gap-3">
                <div className="overflow-hidden rounded-2xl border border-border bg-surface transition-colors focus-within:border-accent">
                  {/* Live thousand separators are a display-only transform -
                      `text` itself stays exactly what it always was (plain
                      digits, no separators this box inserted), which is what
                      buildQuickParsedTransaction/extractAmount and `rawInput`
                      below still receive. See the component's own header
                      comment for why that's load-bearing in both directions. */}
                  <NaturalLanguageAmountTextarea
                    value={text}
                    onChange={setText}
                    placeholder="مثلاً: ۵۰ هزار تومن ناهار خوردم"
                    rows={4}
                    autoFocus
                    disabled={isQuickSaving}
                    aria-describedby={hintId}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        handleQuickSubmit();
                      }
                    }}
                    className="block w-full resize-none bg-transparent px-4 pb-2 pt-4 text-[15px] leading-7 text-foreground outline-none placeholder:text-muted/70 disabled:opacity-60"
                  />
                  {/* What "ثبت تراکنش" will actually save, before it's tapped -
                      and, when it's disabled, why. Only the amount is shown:
                      type/category/date are still refined by the background
                      AI enrichment after the save (lib/workflows/enrich-transaction.ts). */}
                  <div id={hintId} className="flex min-h-11 items-center gap-2 border-t border-border px-4 py-2.5 text-xs">
                    {quickParsed ? (
                      <>
                        <CheckIcon className="h-4 w-4 shrink-0 text-success" />
                        <span className="text-muted">مبلغ</span>
                        <span className="font-semibold tabular-fa text-foreground">{formatToman(quickParsed.amount)}</span>
                        <span className="ms-auto flex shrink-0 items-center gap-1 text-muted">
                          <SparklesIcon className="h-3.5 w-3.5" />
                          دسته‌بندی خودکار
                        </span>
                      </>
                    ) : trimmed ? (
                      <span className="text-muted">مبلغ تشخیص داده نشد؛ مثلاً «۵۰ هزار» یا «۵۰۰۰۰» بنویس.</span>
                    ) : (
                      <span className="text-muted">پیامک بانک رو هم می‌تونی مستقیم اینجا بچسبونی.</span>
                    )}
                  </div>
                </div>

                <DateField value={dateValue} onChange={setManualDate} fieldClassName="rounded-2xl bg-surface py-3.5" />
              </div>

              <div className={stickyFooterClass}>
                {error && (
                  <p role="alert" className="mb-3 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">
                    {error}
                  </p>
                )}
                {/* Disabled whenever the text has no deterministically-extractable
                    amount (lib/extract-amount.ts) or, failing that, no
                    deterministically-parseable bank SMS (lib/bank/parse-bank-sms.ts) -
                    handleQuickSubmit relies on that same buildQuickParsedTransaction
                    succeeding, so this is real feedback, not just a style cue. */}
                <button
                  type="button"
                  onClick={handleQuickSubmit}
                  disabled={!quickParsed || isQuickSaving}
                  title="دسته‌بندی به‌صورت خودکار توسط هوش مصنوعی تکمیل می‌شود"
                  className={`w-full ${primaryButtonClass(isQuickSaving)}`}
                >
                  {isQuickSaving ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <ZapIcon className="h-4 w-4" />}
                  ثبت تراکنش
                </button>
              </div>
            </div>
          );
        })()
      ) : (
        parsed && (
          <div className="mt-5 flex flex-1 flex-col">
            <div className="rounded-2xl border border-border bg-surface p-4">
              {parsed.source === "bank-sms" && parsed.bank && parsed.bank !== "unknown" && (
                <div className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent">
                  <ChatIcon className="h-3.5 w-3.5" />
                  پیامک بانکی · {getBankLabel(parsed.bank)}
                </div>
              )}

              <div role="group" aria-label="نوع تراکنش" className="grid grid-cols-2 gap-1 rounded-xl bg-background p-1">
                {(["expense", "income"] as const).map((t) => {
                  const active = parsed.type === t;
                  const TypeIcon = t === "income" ? ArrowUpIcon : ArrowDownIcon;
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        setParsed({
                          ...parsed,
                          type: t,
                          category: categories.find((c) => isSelectableCategory(c, t, undefined))?.name ?? parsed.category,
                        })
                      }
                      className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-colors ${
                        active
                          ? t === "income"
                            ? "bg-success/15 text-success"
                            : "bg-warning/15 text-warning"
                          : "text-muted hover:text-foreground"
                      }`}
                    >
                      <TypeIcon className="h-4 w-4" />
                      {t === "income" ? "درآمد" : "هزینه"}
                    </button>
                  );
                })}
              </div>

              {/* The amount is the one field every transaction is about, so
                  it's the big editable number here rather than one more
                  small input - which also made the old read-only "مبلغ
                  نهایی" echo of it at the bottom of this card redundant. */}
              <div className="mt-3 rounded-2xl bg-background px-4 pb-4 pt-3 text-center ring-1 ring-transparent transition-shadow focus-within:ring-accent">
                <label htmlFor={`${fieldIds}-amount`} className={FIELD_LABEL_CLASS}>
                  مبلغ (تومان)
                </label>
                <AmountInput
                  id={`${fieldIds}-amount`}
                  value={parsed.amount}
                  onChange={(amount) => setParsed({ ...parsed, amount })}
                  placeholder="۰"
                  className={`mt-1 w-full bg-transparent text-center text-3xl font-bold tabular-fa outline-none placeholder:text-muted/40 ${
                    parsed.type === "income" ? "text-success" : "text-warning"
                  }`}
                />
              </div>

              <div className="mt-5 flex flex-col gap-4">
                <div>
                  <label htmlFor={`${fieldIds}-category`} className={FIELD_LABEL_CLASS}>
                    دسته‌بندی
                  </label>
                  <SelectField
                    id={`${fieldIds}-category`}
                    value={parsed.category}
                    onChange={(category) => setParsed({ ...parsed, category })}
                    highlighted={parsed.source === "bank-sms"}
                  >
                    {availableCategories.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.icon} {c.name}
                      </option>
                    ))}
                  </SelectField>
                  {parsed.needsConfirmation && (
                    <p className="mt-1.5 text-xs text-warning">{getConfirmationHintText(parsed)}</p>
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
                </div>

                <div>
                  <label htmlFor={`${fieldIds}-account`} className={FIELD_LABEL_CLASS}>
                    حساب
                  </label>
                  <SelectField id={`${fieldIds}-account`} value={accountId} onChange={(value) => setAccountId(Number(value))}>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {getAccountTypeIcon(a.type)} {a.name}
                      </option>
                    ))}
                  </SelectField>
                  {isSavingsAccountSelected && (
                    <div className="mt-2 rounded-xl bg-accent/10 px-3 py-2 text-xs leading-5 text-accent">
                      داری با حساب پس‌انداز کار می‌کنی؟ اگه داری بین حساب‌های خودت پول جابه‌جا می‌کنی، صفحه‌ی انتقال
                      داخلی راحت‌تره.{" "}
                      <Link href="/app/transfer" className="font-medium underline">
                        رفتن به انتقال
                      </Link>
                    </div>
                  )}
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
                </div>

                <div>
                  <label htmlFor={`${fieldIds}-description`} className={FIELD_LABEL_CLASS}>
                    توضیح
                  </label>
                  <input
                    id={`${fieldIds}-description`}
                    type="text"
                    value={parsed.description}
                    onChange={(e) => setParsed({ ...parsed, description: e.target.value })}
                    placeholder="اختیاری"
                    className="mt-1.5 w-full rounded-xl border border-border bg-background px-3.5 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted/60 focus:border-accent"
                  />
                </div>

                <div>
                  <span className={FIELD_LABEL_CLASS}>تاریخ</span>
                  <div className="mt-1.5">
                    <DateField
                      value={parsed.date}
                      onChange={(date) => setParsed({ ...parsed, date })}
                      fieldClassName="rounded-xl bg-background py-3"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className={stickyFooterClass}>
              {error && (
                <p role="alert" className="mb-3 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">
                  {error}
                </p>
              )}
              <div className="flex gap-2.5">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={stage === "saving" || isCreatingBankAccount || isCreatingCategory || parsed.amount <= 0}
                  className={`flex-[2] ${primaryButtonClass(stage === "saving")}`}
                >
                  {stage === "saving" ? (
                    <SpinnerIcon className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckIcon className="h-4 w-4" />
                  )}
                  {isEdit ? "ذخیره تغییرات" : "تأیید و ذخیره"}
                </button>
                <button
                  type="button"
                  onClick={isEdit ? () => router.push("/app/transactions") : handleReset}
                  disabled={stage === "saving"}
                  className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-border bg-surface py-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-50"
                >
                  {isEdit ? <XIcon className="h-4 w-4" /> : <EditIcon className="h-4 w-4" />}
                  {isEdit ? "انصراف" : "ویرایش متن"}
                </button>
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}
