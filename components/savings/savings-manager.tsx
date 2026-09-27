"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckIcon,
  XIcon,
  SpinnerIcon,
  TrashIcon,
  BanIcon,
  ShieldIcon,
  PiggyBankIcon,
  TransferIcon,
} from "@/components/icons";
import { EmptyState } from "@/components/empty-state";
import { AmountInput } from "@/components/ui/amount-input";
import { formatToman, formatNumber, formatDecimal } from "@/lib/format";
import { MAX_SAVINGS_STRATEGY_TARGET_AMOUNT } from "@/lib/limits";
import { ASSET_TYPES, getAssetTypeOption, type AssetType } from "@/lib/assets";
import { pickDefaultTransferAccounts, type AccountOption } from "@/lib/accounts";

// Local shapes rather than importing lib/data/savings-strategies.ts/
// lib/savings/formulas.ts directly - both are "server-only" (this is a
// client component), same precedent as GoalsManager's own local Goal/
// GoalFeasibility interfaces next to the "server-only" lib/data/goals.ts.
type SavingsStrategyFormulaType = "fifty_thirty_twenty" | "pay_yourself_first" | "leftover" | "roundup" | "custom";

// Same order as lib/data/savings-strategies.ts's own SAVINGS_STRATEGY_FORMULA_TYPES
// - drives the cards grid's rendering order.
const SAVINGS_STRATEGY_FORMULA_TYPES: SavingsStrategyFormulaType[] = [
  "fifty_thirty_twenty",
  "pay_yourself_first",
  "leftover",
  "roundup",
  "custom",
];

type SavingsStrategyStatus = "active" | "paused" | "abandoned";

interface SavingsFormulaSuggestion {
  formulaType: SavingsStrategyFormulaType;
  targetPercent: number | null;
  targetAmount: number | null;
  suggestedMonthlyAmount: number | null;
  hasData: boolean;
}

interface SavingsStrategy {
  id: number;
  formulaType: string;
  targetPercent: number | null;
  targetAmount: number | null;
  status: string;
}

interface ImplementFormState {
  formulaType: SavingsStrategyFormulaType;
  mode: "percent" | "amount";
  value: string;
}

// Local shape for the read-only goal-allocation section - the fields this
// view needs from lib/data/goals.ts's GoalWithFeasibility (fetched by
// app/app/savings/page.tsx, which trims it down to this before passing it
// down), not the full row/feasibility object that view doesn't use. Same
// "local shape next to a server-only lib file" precedent as this file's own
// SavingsStrategy/SavingsFormulaSuggestion above.
interface GoalAllocation {
  id: number;
  name: string;
  targetAmount: number;
  alreadySaved: number;
  availableBalance: number;
  status: string;
}

// GET /api/assets/live-prices response shape - same shape/comment as
// components/assets/assets-manager.tsx's own local copy (that file can't be
// imported from here, and this is a plain response shape, not exported from
// anywhere).
interface LivePricesResponse {
  unavailable: boolean;
  goldGramPricePerUnit?: number;
  usdPricePerUnit?: number;
  bitcoinPricePerUnit?: number;
  stale?: boolean;
}

const LIVE_PRICE_FIELD: Partial<Record<AssetType, keyof LivePricesResponse>> = {
  gold: "goldGramPricePerUnit",
  usd: "usdPricePerUnit",
  bitcoin: "bitcoinPricePerUnit",
};

interface ConvertAssetFormState {
  type: AssetType;
  name: string;
  // Toman amount - only meaningful/shown for a live-priced type (quantity is
  // derived from it, see handleConvertToAsset below).
  amount: string;
  // Only meaningful/shown for "custom" (no live price to derive from).
  quantity: string;
  purchasePricePerUnit: string;
}

function emptyConvertAssetForm(): ConvertAssetFormState {
  return { type: "gold", name: "", amount: "", quantity: "", purchasePricePerUnit: "" };
}

function todayInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const FORMULA_LABEL: Record<SavingsStrategyFormulaType, string> = {
  fifty_thirty_twenty: "۵۰/۳۰/۲۰",
  pay_yourself_first: "اول به خودت پرداخت کن",
  leftover: "ته‌مانده‌ی ماه",
  roundup: "گرد کردن تراکنش‌ها",
  custom: "دلخواه",
};

const FORMULA_DESCRIPTION: Record<SavingsStrategyFormulaType, string> = {
  fifty_thirty_twenty: "۵۰٪ نیازها، ۳۰٪ خواسته‌ها، ۲۰٪ پس‌انداز از درآمد ماهانه.",
  pay_yourself_first: "قبل از هر خرجی، بخشی از درآمدت رو کنار بذار.",
  leftover: "هرچی آخر ماه از درآمدت باقی موند رو پس‌انداز کن.",
  roundup: "مبلغ هر تراکنش رو گرد کن و مابه‌التفاوتش رو پس‌انداز کن.",
  custom: "درصد یا مبلغ دلخواه خودت رو برای پس‌انداز ماهانه تعیین کن.",
};

// Same tone-color mapping approach as GoalsManager's own FEASIBILITY_TONE -
// this codebase has only two real status colors (success, warning - see
// app/globals.css), reused here across three states instead of a fourth
// color, exactly like FEASIBILITY_TONE reuses "warning" for two of its own
// three states.
const STRATEGY_STATUS_TONE: Record<SavingsStrategyStatus, { badge: string; label: string; Icon: typeof CheckIcon }> = {
  active: { badge: "bg-success/15 text-success", label: "فعال", Icon: CheckIcon },
  paused: { badge: "bg-warning/15 text-warning", label: "متوقف‌شده", Icon: ShieldIcon },
  abandoned: { badge: "bg-border/40 text-muted", label: "رهاشده", Icon: BanIcon },
};

const gridVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0 },
};

// Toman/percent input: comma-grouped display + digit-only parsing, the same
// pattern as GoalsManager's/AssetsManager's own local MoneyInput.
function MoneyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (digits: string) => void;
}) {
  return (
    <>
      <label className="mt-4 block text-xs text-muted">{label}</label>
      <AmountInput value={Number(value) || 0} onChange={(next) => onChange(next ? String(next) : "")} />
    </>
  );
}

// Suggestion's own display figure(s) - see SavingsFormulaSuggestion's own
// doc comment (lib/savings/formulas.ts) for the targetPercent/targetAmount/
// suggestedMonthlyAmount contract this mirrors. Only ever called when
// suggestion.hasData is true.
function suggestionDisplay(suggestion: SavingsFormulaSuggestion): { primary: string; secondary: string | null } {
  if (suggestion.targetPercent !== null) {
    // Percent-based formula - suggestedMonthlyAmount is always shown here,
    // since that's the whole point of surfacing a real Toman figure next to
    // an abstract percent (see this task's own spec).
    const secondary =
      suggestion.suggestedMonthlyAmount !== null ? `≈ ${formatToman(suggestion.suggestedMonthlyAmount)} در ماه` : null;
    return { primary: `${formatNumber(suggestion.targetPercent)}٪`, secondary };
  }
  if (suggestion.targetAmount !== null) {
    // Amount-based formula - suggestedMonthlyAmount duplicates targetAmount
    // exactly for these formulas (see suggestSavingsAmount), so it's only
    // shown when it actually differs.
    const secondary =
      suggestion.suggestedMonthlyAmount !== null && suggestion.suggestedMonthlyAmount !== suggestion.targetAmount
        ? `≈ ${formatToman(suggestion.suggestedMonthlyAmount)} در ماه`
        : null;
    return { primary: formatToman(suggestion.targetAmount), secondary };
  }
  return { primary: "—", secondary: null };
}

function strategyAmountLabel(strategy: SavingsStrategy): string {
  if (strategy.targetPercent !== null) return `${formatNumber(strategy.targetPercent)}٪`;
  if (strategy.targetAmount !== null) return formatToman(strategy.targetAmount);
  return "—";
}

// Toman amount for an active strategy's "do this transfer now" shortcut: the
// strategy's own stored targetAmount if it has one, else the matching
// formula suggestion's suggestedMonthlyAmount (for a percent-based strategy,
// which stores no Toman figure of its own) - reusing the `suggestions` prop
// rather than recomputing anything. The suggestion fallback only counts when
// its hasData is true, same "don't show a number we don't actually have"
// rule as the cards grid (e.g. roundup's suggestedMonthlyAmount is a
// placeholder default with hasData:false). null = nothing to pre-fill, so the
// caller omits the shortcut entirely.
function resolveTransferAmount(strategy: SavingsStrategy, suggestions: SavingsFormulaSuggestion[]): number | null {
  const suggestion = suggestions.find((s) => s.formulaType === strategy.formulaType);
  const candidates = [strategy.targetAmount, suggestion?.hasData ? suggestion.suggestedMonthlyAmount : null];
  return candidates.find((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0) ?? null;
}

// clamp((alreadySaved + availableBalance) / targetAmount, 0, 1) as a 0-100
// percentage - same clamp-to-[0,1] shape as GoalsManager's own
// progressPercent (components/goals/goals-manager.tsx), mirrored rather than
// reinvented since both are "how much of this goal's target is covered".
function goalCoveragePercent(goal: GoalAllocation): number {
  if (goal.targetAmount <= 0) return 0;
  return Math.min(100, Math.max(0, ((goal.alreadySaved + goal.availableBalance) / goal.targetAmount) * 100));
}

// clamp(actual / target, 0, 1) as a 0-100 percentage - same clamp shape as
// goalCoveragePercent above. `target` is always > 0 here (resolveTransferAmount
// only returns positive amounts).
function monthProgressPercent(actual: number, target: number): number {
  return Math.min(100, Math.max(0, (actual / target) * 100));
}

// Shared backdrop/sheet motion wrapper for this file's two bottom-sheet
// modals (implement-strategy, convert-to-asset) - same
// AnimatePresence/spring shape both need, factored out once rather than
// duplicated twice.
function BottomSheetModal({
  onClose,
  disableClose,
  children,
}: {
  onClose: () => void;
  disableClose: boolean;
  children: ReactNode;
}) {
  return (
    <motion.div
      key="backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => !disableClose && onClose()}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 32, stiffness: 320 }}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

/**
 * پس‌انداز ("savings") tab: formula suggestion cards (derived server-side
 * from the user's own MonthlyFinancialProfile via suggestAllFormulas) plus
 * the user's own already-implemented SavingsStrategy rows, with
 * pause/abandon/delete actions. Modeled on components/goals/goals-manager.tsx
 * for the overall shape (header, bottom-sheet modal form, MoneyInput
 * pattern, EmptyState usage, inline delete-confirm toggle) - the closest
 * existing "list + bottom-sheet modal form" page - with Framer Motion
 * layered on top for the cards' entrance, the modal's open/close, and the
 * strategy list's add/remove transitions (see this task's own spec for why:
 * first motion library in this project).
 */
export function SavingsManager({
  strategies,
  suggestions,
  goals,
  accounts,
  actualTransferredThisMonth,
}: {
  strategies: SavingsStrategy[];
  suggestions: SavingsFormulaSuggestion[];
  goals: GoalAllocation[];
  accounts: AccountOption[];
  // Real Toman total transferred into savings accounts this Jalali month
  // (lib/data/accounts.ts's getSavingsTransferredThisMonth). One figure for
  // the whole page, not per strategy - transfers aren't tagged to a specific
  // SavingsStrategy, so every active row compares this same number against its
  // own target.
  actualTransferredThisMonth: number;
}) {
  const router = useRouter();
  const [implementForm, setImplementForm] = useState<ImplementFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [updatingStatusId, setUpdatingStatusId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);

  const [convertForm, setConvertForm] = useState<ConvertAssetFormState | null>(null);
  const [convertSaving, setConvertSaving] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [convertLivePrices, setConvertLivePrices] = useState<LivePricesResponse | null>(null);
  const [convertLivePricesLoading, setConvertLivePricesLoading] = useState(false);

  function openImplement(suggestion: SavingsFormulaSuggestion) {
    // Percent-based suggestions edit targetPercent, amount-based ones edit
    // targetAmount - "custom" (both null) defaults to amount mode, since a
    // raw Toman figure is the more generally graspable starting point when
    // there's no suggestion to anchor a percent to.
    const mode: "percent" | "amount" = suggestion.targetPercent !== null ? "percent" : "amount";
    const initialValue = mode === "percent" ? suggestion.targetPercent : suggestion.targetAmount;
    setImplementForm({
      formulaType: suggestion.formulaType,
      mode,
      value: initialValue !== null ? String(initialValue) : "",
    });
    setError(null);
  }

  async function handleImplement() {
    if (!implementForm) return;

    const value = Number(implementForm.value);
    if (implementForm.mode === "percent") {
      if (!Number.isFinite(value) || value <= 0 || value > 100) {
        setError("درصد هدف نامعتبر است.");
        return;
      }
    } else {
      if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > MAX_SAVINGS_STRATEGY_TARGET_AMOUNT) {
        setError("مبلغ هدف نامعتبر است.");
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const payload = {
        formulaType: implementForm.formulaType,
        status: "active",
        ...(implementForm.mode === "percent" ? { targetPercent: value } : { targetAmount: value }),
      };
      const res = await fetch("/api/savings-strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ذخیره‌سازی.");
      setImplementForm(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(id: number, status: SavingsStrategyStatus) {
    setUpdatingStatusId(id);
    setListError(null);
    try {
      const res = await fetch(`/api/savings-strategies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در بروزرسانی وضعیت.");
      router.refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setUpdatingStatusId(null);
    }
  }

  async function handleDelete(id: number) {
    setDeletingId(id);
    setListError(null);
    try {
      const res = await fetch(`/api/savings-strategies/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در حذف.");
      router.refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setDeletingId(null);
      setConfirmingDeleteId(null);
    }
  }

  function openConvertToAsset() {
    setConvertForm(emptyConvertAssetForm());
    setConvertError(null);
    // Fetched fresh per open, same reasoning as AssetsManager's own
    // openCreate - prices move and the modal can stay open a while.
    setConvertLivePrices(null);
    setConvertLivePricesLoading(true);
    fetch("/api/assets/live-prices")
      .then((res) => res.json())
      .then((data: LivePricesResponse) => setConvertLivePrices(data))
      .catch(() => setConvertLivePrices({ unavailable: true }))
      .finally(() => setConvertLivePricesLoading(false));
  }

  function selectConvertType(type: AssetType) {
    setConvertForm((f) => (f ? { ...emptyConvertAssetForm(), type } : f));
  }

  const isConvertCustom = convertForm?.type === "custom";
  const convertLiveField = convertForm && !isConvertCustom ? LIVE_PRICE_FIELD[convertForm.type] : undefined;
  const convertPrice =
    convertLiveField && convertLivePrices && !convertLivePrices.unavailable ? convertLivePrices[convertLiveField] : undefined;
  const convertAmountNumber = convertForm ? Number(convertForm.amount) : NaN;
  const derivedQuantity =
    !isConvertCustom && typeof convertPrice === "number" && convertPrice > 0 && Number.isFinite(convertAmountNumber) && convertAmountNumber > 0
      ? Number((convertAmountNumber / convertPrice).toFixed(6))
      : null;
  // No manual-price fallback for a live-priced type here (unlike
  // AssetsManager's own create form) - there's no sensible manual price to
  // type for a "convert an amount" flow without a reference price, so an
  // unavailable live price disables the whole flow rather than falling back
  // to hand entry.
  const convertConfirmDisabled = !isConvertCustom && (convertLivePricesLoading || typeof convertPrice !== "number");

  async function handleConvertToAsset() {
    if (!convertForm) return;

    let quantity: number;
    let purchasePricePerUnit: number;

    if (isConvertCustom) {
      if (!convertForm.name.trim()) {
        setConvertError("برای دارایی دستی، نام الزامی است.");
        return;
      }
      quantity = Number(convertForm.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setConvertError("مقدار دارایی نامعتبر است.");
        return;
      }
      purchasePricePerUnit = Number(convertForm.purchasePricePerUnit);
      if (!Number.isFinite(purchasePricePerUnit) || purchasePricePerUnit <= 0) {
        setConvertError("قیمت خرید نامعتبر است.");
        return;
      }
    } else {
      if (typeof convertPrice !== "number") {
        setConvertError("قیمت لحظه‌ای در دسترس نیست.");
        return;
      }
      if (derivedQuantity === null || derivedQuantity <= 0) {
        setConvertError("مبلغ نامعتبر است.");
        return;
      }
      quantity = derivedQuantity;
      purchasePricePerUnit = convertPrice;
    }

    setConvertSaving(true);
    setConvertError(null);
    try {
      const payload: Record<string, unknown> = {
        type: convertForm.type,
        quantity,
        purchasePricePerUnit,
        purchaseDate: todayInputValue(),
        note: null,
      };
      if (isConvertCustom) payload.name = convertForm.name.trim();

      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ذخیره‌سازی.");
      setConvertForm(null);
      router.refresh();
    } catch (err) {
      setConvertError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setConvertSaving(false);
    }
  }

  const activeGoals = goals.filter((g) => g.status === "active");

  // "Do this transfer now" shortcut endpoints - same rule the dashboard's
  // income-reaction banner uses (lib/accounts.ts).
  const { from: transferFromAccount, to: transferToAccount } = pickDefaultTransferAccounts(accounts);
  const hasActiveStrategy = strategies.some((s) => s.status === "active");

  return (
    <div className="space-y-6 px-4 pb-8 pt-6">
      <header>
        <h1 className="text-lg font-bold text-foreground">پس‌انداز</h1>
        <p className="mt-1 text-sm text-muted">یکی از فرمول‌های زیر رو پیاده‌سازی کن تا پس‌اندازت خودکار پیگیری بشه.</p>
      </header>

      <motion.div variants={gridVariants} initial="hidden" animate="visible" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SAVINGS_STRATEGY_FORMULA_TYPES.map((formulaType) => {
          const suggestion = suggestions.find((s) => s.formulaType === formulaType);
          if (!suggestion) return null;
          const display = suggestion.hasData ? suggestionDisplay(suggestion) : null;

          return (
            <motion.div key={formulaType} variants={cardVariants} className="rounded-2xl border border-border bg-surface p-4">
              <p className="text-sm font-semibold text-foreground">{FORMULA_LABEL[formulaType]}</p>
              <p className="mt-1 text-xs text-muted">{FORMULA_DESCRIPTION[formulaType]}</p>

              {display ? (
                <div className="mt-3">
                  <p className="text-base font-semibold tabular-fa text-foreground">{display.primary}</p>
                  {display.secondary && <p className="mt-0.5 text-xs tabular-fa text-muted">{display.secondary}</p>}
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted">هنوز داده‌ی کافی برای پیشنهاد شخصی‌سازی‌شده نیست</p>
              )}

              {/* An already-active strategy of this formula blocks a second
                  one (the API's 409 is only the backstop - see
                  DuplicateActiveStrategyError in lib/data/savings-strategies.ts). */}
              {strategies.some((s) => s.formulaType === formulaType && s.status === "active") ? (
                <button
                  type="button"
                  disabled
                  className="mt-3 flex w-full items-center justify-center rounded-xl bg-border/40 py-2 text-xs font-semibold text-muted"
                >
                  از قبل فعاله
                </button>
              ) : (
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.97 }}
                  onClick={() => openImplement(suggestion)}
                  className="mt-3 flex w-full items-center justify-center rounded-xl bg-primary py-2 text-xs font-semibold text-on-primary"
                >
                  پیاده‌سازی
                </motion.button>
              )}
            </motion.div>
          );
        })}
      </motion.div>

      {listError && <p className="rounded-xl bg-warning/10 p-3 text-xs text-warning">{listError}</p>}

      {strategies.length === 0 ? (
        <EmptyState
          icon={<PiggyBankIcon className="h-6 w-6" />}
          title="هنوز هیچ استراتژی‌ای رو پیاده‌سازی نکرده‌اید"
          description="یکی از فرمول‌های بالا رو پیاده‌سازی کن تا اینجا نمایش داده بشه."
        />
      ) : (
        <div className="space-y-3">
          {/* Once for the whole list, not per row - and only when there's an
              active strategy the shortcut would apply to. Same wording/link
              pattern as app/app/transfer/page.tsx's own <2-accounts
              EmptyState. */}
          {hasActiveStrategy && !transferToAccount && (
            <p className="text-xs text-muted">
              برای این کار به یک حساب پس‌انداز نیاز داری؛{" "}
              <Link href="/app/settings/accounts" className="font-medium text-accent">
                افزودن حساب
              </Link>
              .
            </p>
          )}
          <AnimatePresence initial={false}>
            {strategies.map((strategy) => {
              const status = strategy.status as SavingsStrategyStatus;
              const tone = STRATEGY_STATUS_TONE[status];
              const isActive = status === "active";
              const isPaused = status === "paused";
              const confirmingDelete = confirmingDeleteId === strategy.id;

              // A plain Link into the real transfer form with everything
              // pre-filled (see app/app/transfer/page.tsx's parseTransferPrefill),
              // not a fetch - this shortcut never transfers anything itself.
              // Omitted silently (no disabled state) when there's no amount
              // to pre-fill or no from/to account pair to pick.
              const transferAmount = isActive ? resolveTransferAmount(strategy, suggestions) : null;
              const transferHref =
                transferAmount !== null && transferFromAccount && transferToAccount
                  ? `/app/transfer?from=${transferFromAccount.id}&to=${transferToAccount.id}&amount=${transferAmount}&note=${encodeURIComponent(
                      "پیاده‌سازی استراتژی " +
                        (FORMULA_LABEL[strategy.formulaType as SavingsStrategyFormulaType] ?? strategy.formulaType)
                    )}`
                  : null;

              return (
                <motion.div
                  key={strategy.id}
                  layout
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="rounded-2xl border border-border bg-surface p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {FORMULA_LABEL[strategy.formulaType as SavingsStrategyFormulaType] ?? strategy.formulaType}
                      </p>
                      <p className="mt-1 text-sm tabular-fa text-muted">{strategyAmountLabel(strategy)}</p>
                    </div>
                    {confirmingDelete ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          onClick={() => handleDelete(strategy.id)}
                          disabled={deletingId === strategy.id}
                          className="rounded-lg bg-warning px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        >
                          {deletingId === strategy.id ? (
                            <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            "حذف"
                          )}
                        </button>
                        <button
                          onClick={() => setConfirmingDeleteId(null)}
                          disabled={deletingId === strategy.id}
                          className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted"
                        >
                          انصراف
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmingDeleteId(strategy.id)}
                        aria-label="حذف"
                        className="shrink-0 rounded-full p-2 text-muted hover:bg-background hover:text-warning"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${tone.badge}`}>
                      <tone.Icon className="h-3.5 w-3.5" />
                      {tone.label}
                    </span>
                  </div>

                  {/* Active rows only - paused/abandoned have nothing ongoing
                      to track. Reuses transferAmount (resolveTransferAmount)
                      as the target, so a row with no resolvable target
                      shows no progress line, same "don't show a number we
                      don't have" rule as the shortcut above. Bar markup
                      mirrors the goal-allocation section's own. */}
                  {transferAmount !== null && (
                    <div className="mt-3" data-testid="strategy-month-progress">
                      <p className="text-xs tabular-fa text-muted">
                        این ماه: {formatToman(actualTransferredThisMonth)} از {formatToman(transferAmount)}
                      </p>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-border/60">
                        <div
                          className={`h-full rounded-full ${actualTransferredThisMonth >= transferAmount ? "bg-success" : "bg-primary"}`}
                          style={{ width: `${monthProgressPercent(actualTransferredThisMonth, transferAmount)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {(isActive || isPaused) && (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                      {isActive && (
                        <>
                          {transferHref && (
                            <Link
                              href={transferHref}
                              className="flex basis-full items-center justify-center gap-1.5 rounded-xl bg-primary py-2 text-xs font-semibold text-on-primary"
                            >
                              <TransferIcon className="h-3.5 w-3.5" />
                              همین الان انتقالشو انجام بده
                            </Link>
                          )}
                          <button
                            type="button"
                            onClick={() => handleStatusChange(strategy.id, "paused")}
                            disabled={updatingStatusId === strategy.id}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-border/40 py-2 text-xs font-semibold text-muted disabled:opacity-50"
                          >
                            <ShieldIcon className="h-3.5 w-3.5" />
                            متوقف کردن
                          </button>
                          <button
                            type="button"
                            onClick={() => handleStatusChange(strategy.id, "abandoned")}
                            disabled={updatingStatusId === strategy.id}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-warning/10 py-2 text-xs font-semibold text-warning disabled:opacity-50"
                          >
                            <BanIcon className="h-3.5 w-3.5" />
                            رها کردن
                          </button>
                        </>
                      )}
                      {isPaused && (
                        <button
                          type="button"
                          onClick={() => handleStatusChange(strategy.id, "active")}
                          disabled={updatingStatusId === strategy.id}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-success/10 py-2 text-xs font-semibold text-success disabled:opacity-50"
                        >
                          <CheckIcon className="h-3.5 w-3.5" />
                          فعال کردن
                        </button>
                      )}
                    </div>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* Goal-allocation (read-only) - display only, per the earlier product
          decision: manual allocation touches feasibility.ts's shared
          even-split logic, out of scope here. A secondary, read-only block
          (not the page's own primary interactive surface, which the cards
          grid above already animates per-item), so a single fade+slide-up on
          the section as a whole is enough rather than per-row stagger. */}
      <motion.section
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="space-y-3"
      >
        <h2 className="text-sm font-semibold text-foreground">تخصیص به هدف‌ها</h2>
        {activeGoals.length === 0 ? (
          <p className="text-xs text-muted">
            هنوز هدف فعالی نداری؛{" "}
            <Link href="/app/dashboard?tab=goals" className="font-medium text-accent">
              از تب هدف‌ها یکی بساز
            </Link>
            .
          </p>
        ) : (
          <div className="rounded-2xl border border-border bg-surface p-4">
            {activeGoals.map((goal, i) => {
              const percent = goalCoveragePercent(goal);
              const covered = goal.alreadySaved + goal.availableBalance;
              return (
                <div key={goal.id} className={i > 0 ? "mt-3 border-t border-border pt-3" : ""}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{goal.name}</p>
                    <span className="shrink-0 text-xs tabular-fa text-muted">{formatNumber(Math.round(percent))}٪</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-border/60">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-xs tabular-fa text-muted">
                    <span>پوشش داده‌شده: {formatToman(covered)}</span>
                    <span>هدف: {formatToman(goal.targetAmount)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </motion.section>

      <button
        type="button"
        onClick={openConvertToAsset}
        className="flex w-full items-center justify-center gap-1.5 rounded-2xl bg-accent/10 py-3 text-sm font-semibold text-accent"
      >
        <TransferIcon className="h-4 w-4" />
        تبدیل پس‌انداز به دارایی
      </button>

      <AnimatePresence>
        {implementForm && (
          <BottomSheetModal onClose={() => setImplementForm(null)} disableClose={saving}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-foreground">
                پیاده‌سازی {FORMULA_LABEL[implementForm.formulaType]}
              </h2>
              <button onClick={() => setImplementForm(null)} disabled={saving} aria-label="بستن">
                <XIcon className="h-5 w-5 text-muted" />
              </button>
            </div>

            <MoneyInput
              label={implementForm.mode === "percent" ? "درصد هدف (٪)" : "مبلغ هدف (تومان)"}
              value={implementForm.value}
              onChange={(digits) => setImplementForm({ ...implementForm, value: digits })}
            />

            {error && <p className="mt-3 text-xs text-warning">{error}</p>}

            <button
              onClick={handleImplement}
              disabled={saving}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary disabled:opacity-50"
            >
              {saving ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
              ذخیره
            </button>
          </BottomSheetModal>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {convertForm && (
          <BottomSheetModal onClose={() => setConvertForm(null)} disableClose={convertSaving}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-foreground">تبدیل پس‌انداز به دارایی</h2>
              <button onClick={() => setConvertForm(null)} disabled={convertSaving} aria-label="بستن">
                <XIcon className="h-5 w-5 text-muted" />
              </button>
            </div>

            <p className="mb-2 text-xs text-muted">نوع دارایی</p>
            <div className="grid grid-cols-2 gap-2">
              {ASSET_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => selectConvertType(t.value)}
                  className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-medium ${
                    convertForm.type === t.value ? "bg-primary text-on-primary" : "bg-background text-muted"
                  }`}
                >
                  <span>{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>

            {isConvertCustom ? (
              <>
                <label className="mt-4 block text-xs text-muted">نام دارایی</label>
                <input
                  type="text"
                  value={convertForm.name}
                  onChange={(e) => setConvertForm({ ...convertForm, name: e.target.value })}
                  placeholder="مثلاً سهام فولاد، خودرو"
                  className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
                />

                <label className="mt-4 block text-xs text-muted">مقدار</label>
                <input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={convertForm.quantity}
                  onChange={(e) => setConvertForm({ ...convertForm, quantity: e.target.value })}
                  className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
                />

                <MoneyInput
                  label="قیمت خرید (تومان، به ازای هر واحد)"
                  value={convertForm.purchasePricePerUnit}
                  onChange={(digits) => setConvertForm({ ...convertForm, purchasePricePerUnit: digits })}
                />
              </>
            ) : convertLivePricesLoading ? (
              <p className="mt-4 flex items-center gap-1.5 text-xs text-muted">
                <SpinnerIcon className="h-3 w-3 animate-spin" />
                در حال دریافت قیمت لحظه‌ای...
              </p>
            ) : typeof convertPrice === "number" ? (
              <>
                <MoneyInput
                  label="مبلغ (تومان)"
                  value={convertForm.amount}
                  onChange={(digits) => setConvertForm({ ...convertForm, amount: digits })}
                />
                <p className="mt-2 text-xs text-muted">
                  مقدار قابل خرید:{" "}
                  <span className="tabular-fa text-foreground">
                    {derivedQuantity !== null
                      ? `${formatDecimal(derivedQuantity, 6)} ${getAssetTypeOption(convertForm.type)?.unitLabel ?? ""}`
                      : "—"}
                  </span>
                </p>
              </>
            ) : (
              <p className="mt-4 text-xs text-warning">قیمت لحظه‌ای در دسترس نیست</p>
            )}

            {convertError && <p className="mt-3 text-xs text-warning">{convertError}</p>}

            <button
              onClick={handleConvertToAsset}
              disabled={convertSaving || convertConfirmDisabled}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary disabled:opacity-50"
            >
              {convertSaving ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
              ذخیره
            </button>
          </BottomSheetModal>
        )}
      </AnimatePresence>
    </div>
  );
}
