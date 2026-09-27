"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  PlusIcon,
  EditIcon,
  TrashIcon,
  XIcon,
  CheckIcon,
  SpinnerIcon,
  BanIcon,
  ShieldIcon,
  AlertIcon,
  SparklesIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  PiggyBankIcon,
  RefreshIcon,
} from "@/components/icons";
import { EmptyState } from "@/components/empty-state";
import { JalaliDatePicker, daysBetween } from "./jalali-date-picker";
import { formatToman, formatNumber, formatCompactToman } from "@/lib/format";
import { AmountInput } from "@/components/ui/amount-input";
import { MAX_NAME_LENGTH, MAX_GOAL_TARGET_AMOUNT } from "@/lib/limits";

// Local shapes rather than importing lib/data/goals.ts/lib/goals/feasibility.ts
// directly - both are "server-only" (this is a client component) - same
// precedent as components/assets/assets-manager.tsx's own local Asset/
// AssetsSummary interfaces next to the "server-only" lib/data/assets.ts.
type FeasibilityStatus = "on_track" | "needs_adjustment" | "unrealistic";

interface GoalFeasibility {
  requiredMonthlyAmount: number;
  actualMonthlyAverage: number;
  feasibilityStatus: FeasibilityStatus;
  projectedCompletionMonths: number | null;
  gap: number;
}

interface Goal {
  id: number;
  name: string;
  category: string;
  targetAmount: number;
  initialAmount: number;
  deadline: Date | string;
  status: string;
  feasibility: GoalFeasibility;
}

// Local mirror of lib/goals/strategy.ts's GoalStrategy/GoalStrategyAction -
// that module is "server-only" (imports chatCompletion/getSpendingSummary),
// so this client component can't import its types directly, same reason
// GoalFeasibility above is a local copy rather than an import from
// lib/goals/feasibility.ts.
type GoalStrategyActionType = "reduce_expense" | "increase_savings" | "extra_income";

interface GoalStrategyAction {
  type: GoalStrategyActionType;
  title: string;
  description: string;
  relatedAmount?: number;
  priority: number;
}

interface GoalStrategyProgress {
  currentAmount: number;
  targetAmount: number;
  percentage: number;
}

interface GoalStrategyMonthlyAction {
  title: string;
  description: string;
  amount: number;
}

interface GoalStrategy {
  actions: GoalStrategyAction[];
  summary: string;
  progress: GoalStrategyProgress;
  monthlyAction: GoalStrategyMonthlyAction;
  inflationNote: string | null;
  generatedAt: string;
}

interface FormState {
  id: number | null;
  name: string;
  targetAmount: string;
  initialAmount: string;
  deadline: string; // Gregorian yyyy-mm-dd - JalaliDatePicker's value/onChange
  // contract, same string shape the native <input type="date"> it replaced
  // used, so this stays a plain passthrough to the /api/goals request body.
}

// Same tone-color mapping approach as HighlightCard/NarrativeReportCard's
// TONE/STATUS_TONE (border/bg/badge/text per state) - this codebase has only
// two real status colors (success, warning - see app/globals.css), so
// "needs_adjustment" and "unrealistic" share the same warning tone and are
// told apart by icon/label only, exactly like NarrativeReportCard's own
// "medium"/"bad" pair.
const FEASIBILITY_TONE: Record<
  FeasibilityStatus,
  { badge: string; label: string; Icon: typeof CheckIcon }
> = {
  on_track: { badge: "bg-success/15 text-success", label: "در مسیر", Icon: CheckIcon },
  needs_adjustment: { badge: "bg-warning/15 text-warning", label: "نیاز به تعدیل", Icon: ShieldIcon },
  unrealistic: { badge: "bg-warning/15 text-warning", label: "غیرواقعی", Icon: AlertIcon },
};

const GOAL_STATUS_LABEL: Record<string, string> = {
  achieved: "محقق‌شده",
  abandoned: "رهاشده",
};

function todayInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyForm(): FormState {
  return {
    id: null,
    name: "",
    targetAmount: "",
    initialAmount: "",
    deadline: todayInputValue(),
  };
}

function tomorrowDate(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}

// Toman input: comma-grouped display + digit-only parsing, the same pattern
// as assets-manager.tsx's own MoneyInput.
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

function progressPercent(goal: Goal): number {
  if (goal.targetAmount <= 0) return 0;
  return Math.min(100, Math.max(0, (goal.initialAmount / goal.targetAmount) * 100));
}

// Calendar-day (not raw ms) diff to goal.deadline, reusing jalali-date-picker.tsx's
// exported daysBetween - same UTC-midnight approach as lib/reports/period-range.ts's
// own (private) daysBetween, just already exported from that file so no need for a
// third copy here.
function daysRemainingLabel(goal: Goal): string {
  const deadline = typeof goal.deadline === "string" ? new Date(goal.deadline) : goal.deadline;
  const remaining = daysBetween(new Date(), deadline);
  return remaining > 0 ? `${formatNumber(remaining)} روز مانده` : "مهلت گذشته";
}

// GoalStrategyAction.type -> labeled chip (icon + Persian name) on each
// action, so the three kinds read at a glance without the English type
// string. Icons and tones follow what they already mean elsewhere in the
// app: ArrowDown + warning is "expense", ArrowUp + success is "income"
// (components/dashboard/month-summary-card.tsx), and the piggy bank +
// primary is savings (BalanceCard's savings row).
const STRATEGY_ACTION_KIND: Record<
  GoalStrategyActionType,
  { label: string; Icon: typeof ArrowDownIcon; chip: string; amountLabel: string }
> = {
  reduce_expense: { label: "کاهش هزینه", Icon: ArrowDownIcon, chip: "bg-warning/10 text-warning", amountLabel: "خرج فعلی" },
  increase_savings: { label: "پس‌انداز بیشتر", Icon: PiggyBankIcon, chip: "bg-primary/15 text-primary-soft", amountLabel: "مبلغ" },
  extra_income: { label: "درآمد اضافه", Icon: ArrowUpIcon, chip: "bg-success/10 text-success", amountLabel: "مبلغ" },
};

// Computed deterministically (lib/goals/strategy.ts's computeProgress), not
// model-authored, so this stays accurate whatever the AI's own text says.
// Deliberately a sentence, not a second progress bar: the goal card right
// above already has one, and its percentage counts initialAmount only while
// this one also counts the goal's share of the account balance - two bars
// disagreeing on the same card would be worse than one. That share can be
// negative, and "−۲۲ میلیون فراهم شده" reads as nonsense, so that case (and
// zero) get their own wording.
function StrategyProgress({ progress }: { progress: GoalStrategyProgress }) {
  const { currentAmount, targetAmount, percentage } = progress;
  return (
    <p className="text-xs leading-5 text-muted">
      {currentAmount > 0 ? (
        <>
          با سهمت از موجودی حساب‌ها،{" "}
          <span className="font-medium tabular-fa text-foreground">{formatToman(currentAmount)}</span> از{" "}
          <span className="tabular-fa">{formatToman(targetAmount)}</span> جمع شده (
          <span className="tabular-fa">{formatNumber(percentage)}٪</span>).
        </>
      ) : currentAmount < 0 ? (
        <>
          هنوز چیزی برای این هدف کنار نذاشتی؛ سهمش از موجودی‌ات{" "}
          <span className="font-medium tabular-fa text-warning">{formatCompactToman(-currentAmount)} تومان</span> منفیه.
        </>
      ) : (
        "هنوز چیزی برای این هدف کنار نذاشتی."
      )}
    </p>
  );
}

function GoalStrategyCard({
  strategy,
  regenerating,
  error,
  onRegenerate,
}: {
  strategy: GoalStrategy;
  regenerating: boolean;
  error: string | undefined;
  onRegenerate: () => void;
}) {
  const { progress, monthlyAction } = strategy;
  return (
    <div className="rounded-xl bg-background p-3.5">
      {/* Once a strategy exists, regenerating is secondary - a small action
          in the strategy's own header instead of the full-width button that
          used to sit above it and push the strategy down. */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <SparklesIcon className="h-4 w-4 text-primary-soft" />
          <h3 className="text-sm font-semibold text-foreground">استراتژی پیشنهادی</h3>
        </div>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={regenerating}
          className="-me-1.5 flex items-center gap-1 rounded-lg px-1.5 py-1 text-xs font-medium text-primary-soft disabled:opacity-60"
        >
          {regenerating ? <SpinnerIcon className="h-3.5 w-3.5 animate-spin" /> : <RefreshIcon className="h-3.5 w-3.5" />}
          {regenerating ? "در حال ساخت..." : "ساخت دوباره"}
        </button>
      </div>
      <p className="mt-0.5 text-[11px] text-muted">پیشنهاد هوش مصنوعی از روی خرج‌ها و پس‌اندازت</p>
      {error && <p className="mt-2 rounded-lg bg-warning/10 p-2 text-xs text-warning">{error}</p>}

      <div aria-busy={regenerating} className={`transition-opacity ${regenerating ? "opacity-50" : ""}`}>
        <div className="mt-3">
          <StrategyProgress progress={progress} />
        </div>

        <p className="mt-4 text-[13px] leading-6 text-foreground">{strategy.summary}</p>

        {/* The one concrete monthly step, led by its amount - always
            feasibility.requiredMonthlyAmount (see buildMonthlyAction), never
            left to the model's own phrasing to include or omit. */}
        <div className="mt-4 rounded-xl border border-primary/25 bg-primary-bg p-3">
          <p className="text-[11px] font-medium text-primary-soft">قدم اصلی · هر ماه</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-1">
            <span className="text-xl font-black tabular-fa text-foreground">{formatNumber(monthlyAction.amount)}</span>
            <span className="text-xs text-muted">تومان</span>
          </p>
          <p className="mt-2 text-sm font-semibold text-foreground">{monthlyAction.title}</p>
          <p className="mt-1 text-xs leading-6 text-muted">{monthlyAction.description}</p>
        </div>

        <p className="mt-5 text-xs font-medium text-muted">کارهایی که کمک می‌کنه</p>
        <ol className="mt-1">
          {strategy.actions.map((action) => {
            const kind = STRATEGY_ACTION_KIND[action.type];
            return (
              <li key={action.priority} className="flex gap-3 border-b border-border/60 py-3 last:border-b-0 last:pb-0">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-bold tabular-fa text-foreground">
                  {formatNumber(action.priority)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${kind.chip}`}>
                      <kind.Icon className="h-3 w-3" />
                      {kind.label}
                    </span>
                    {action.relatedAmount !== undefined && (
                      <span className="text-[11px] text-muted">
                        {kind.amountLabel}:{" "}
                        <span className="font-semibold tabular-fa text-foreground">
                          {formatCompactToman(action.relatedAmount)} تومان
                        </span>
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm font-semibold text-foreground">{action.title}</p>
                  <p className="mt-1 text-xs leading-6 text-muted">{action.description}</p>
                </div>
              </li>
            );
          })}
        </ol>

        {/* Only rendered when generateGoalStrategy actually included one (long
            enough horizon, past its own instrument-name sanitization) - kept
            at the bottom as a general note, not styled like an actionable
            item. */}
        {strategy.inflationNote && (
          <div className="mt-4 flex gap-2 rounded-xl bg-surface p-3">
            <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
            <div>
              <p className="text-xs font-medium text-foreground">یه نکته درباره‌ی تورم</p>
              <p className="mt-1 text-xs leading-6 text-muted">{strategy.inflationNote}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Generation takes 15-35s (measured, see GOAL_STRATEGY_TIMEOUT_MS in
// lib/goals/strategy.ts) - long enough that a bare spinner looks stuck, so
// this says up front that the wait is expected.
function StrategyLoading() {
  return (
    <div role="status" className="rounded-xl bg-background p-3.5">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <SpinnerIcon className="h-4 w-4 animate-spin text-primary-soft" />
        در حال ساخت استراتژی...
      </div>
      <p className="mt-1 text-xs leading-5 text-muted">
        دارم هدفت رو با خرج‌ها و پس‌اندازت مقایسه می‌کنم. ممکنه تا یک دقیقه طول بکشه.
      </p>
      <div aria-hidden className="mt-4 space-y-2.5">
        <div className="h-3 w-full animate-pulse rounded-full bg-border/60" />
        <div className="h-3 w-4/5 animate-pulse rounded-full bg-border/60" />
        <div className="h-16 w-full animate-pulse rounded-xl bg-border/40" />
      </div>
    </div>
  );
}

function GoalCard({
  goal,
  onEdit,
  onDelete,
  onStatusChange,
  deleting,
  confirmingDelete,
  onRequestDelete,
  onCancelDelete,
  updatingStatus,
  strategy,
  strategyLoading,
  strategyError,
  onGenerateStrategy,
}: {
  goal: Goal;
  onEdit: () => void;
  onDelete: () => void;
  onStatusChange: (status: "achieved" | "abandoned") => void;
  deleting: boolean;
  confirmingDelete: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  updatingStatus: boolean;
  strategy: GoalStrategy | undefined;
  strategyLoading: boolean;
  strategyError: string | undefined;
  onGenerateStrategy: () => void;
}) {
  const tone = FEASIBILITY_TONE[goal.feasibility.feasibilityStatus];
  const percent = progressPercent(goal);
  const isActive = goal.status === "active";

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{goal.name}</p>
        </div>
        {confirmingDelete ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={onDelete}
              disabled={deleting}
              className="rounded-lg bg-warning px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {deleting ? <SpinnerIcon className="h-3.5 w-3.5 animate-spin" /> : "حذف"}
            </button>
            <button
              onClick={onCancelDelete}
              disabled={deleting}
              className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted"
            >
              انصراف
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={onEdit}
              aria-label="ویرایش"
              className="rounded-full p-2 text-muted hover:bg-background hover:text-accent"
            >
              <EditIcon className="h-4 w-4" />
            </button>
            <button
              onClick={onRequestDelete}
              aria-label="حذف"
              className="rounded-full p-2 text-muted hover:bg-background hover:text-warning"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-muted">
        <span>هدف: {formatToman(goal.targetAmount)}</span>
        <span>{daysRemainingLabel(goal)}</span>
      </div>

      <p className="mt-2 text-xs text-muted">{formatNumber(Math.round(percent))}٪ از هدف پر شده</p>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-border/60">
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {goal.status !== "active" && GOAL_STATUS_LABEL[goal.status] && (
          <span className="rounded-full bg-border/40 px-2 py-0.5 text-xs font-semibold text-muted">
            {GOAL_STATUS_LABEL[goal.status]}
          </span>
        )}
        {isActive && (
          <span className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${tone.badge}`}>
            <tone.Icon className="h-3.5 w-3.5" />
            {tone.label}
          </span>
        )}
        {isActive && (
          <span className="text-xs text-muted">
            {goal.feasibility.projectedCompletionMonths !== null
              ? `تخمین رسیدن: ${formatNumber(goal.feasibility.projectedCompletionMonths)} ماه`
              : "قابل دستیابی نیست"}
          </span>
        )}
        {isActive && goal.feasibility.gap > 0 && (
          <span className="text-xs text-muted">کمبود ماهانه: {formatToman(goal.feasibility.gap)}</span>
        )}
      </div>

      {isActive && (
        <div className="mt-3 flex gap-2 border-t border-border pt-3">
          <button
            type="button"
            onClick={() => onStatusChange("achieved")}
            disabled={updatingStatus}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-success/10 py-2 text-xs font-semibold text-success disabled:opacity-50"
          >
            <CheckIcon className="h-3.5 w-3.5" />
            محقق شد
          </button>
          <button
            type="button"
            onClick={() => onStatusChange("abandoned")}
            disabled={updatingStatus}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-border/40 py-2 text-xs font-semibold text-muted disabled:opacity-50"
          >
            <BanIcon className="h-3.5 w-3.5" />
            رها شد
          </button>
        </div>
      )}

      {isActive && (
        <div className="mt-3 border-t border-border pt-3">
          {strategy ? (
            <GoalStrategyCard
              strategy={strategy}
              regenerating={strategyLoading}
              error={strategyError}
              onRegenerate={onGenerateStrategy}
            />
          ) : strategyLoading ? (
            <StrategyLoading />
          ) : (
            <>
              {strategyError && (
                <p className="mb-2 rounded-lg bg-warning/10 p-2 text-xs text-warning">{strategyError}</p>
              )}
              {/* text-primary-soft rather than text-accent: #ffd400 text on
                  its own 10% tint is unreadable in the light theme. */}
              <button
                type="button"
                onClick={onGenerateStrategy}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary/15 py-2.5 text-xs font-semibold text-primary-soft"
              >
                <SparklesIcon className="h-3.5 w-3.5" />
                {strategyError ? "تلاش دوباره" : "دریافت استراتژی"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Goals tab: list + create/edit + status/delete actions, consuming Phase 1's
 * already-live GET/POST/PATCH/DELETE /api/goals (lib/data/goals.ts,
 * unmodified). Modeled on components/assets/assets-manager.tsx for the
 * overall shape (header "add" button, bottom-sheet modal form, its own
 * MoneyInput pattern) - the closest existing "simple CRUD entity list" in
 * this app. Delete confirmation, however, is modeled on
 * components/transactions/transaction-list-item.tsx's inline confirm/cancel
 * toggle instead: assets-manager.tsx/accounts-manager.tsx both delete
 * immediately with no confirmation step at all, which doesn't match this
 * task's "ask for confirmation" requirement, while
 * transaction-list-item.tsx's per-row confirming state does.
 *
 * The category picker (emoji/label grid) that used to sit in this form was
 * removed once the product decision landed that the goal's free-text name
 * is sufficient on its own - see handleSave's own comment on how the
 * category field is still satisfied at the API boundary without it.
 */
export function GoalsManager({ goals }: { goals: Goal[] }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [updatingStatusId, setUpdatingStatusId] = useState<number | null>(null);
  const [strategies, setStrategies] = useState<Record<number, GoalStrategy>>({});
  const [strategyLoadingId, setStrategyLoadingId] = useState<number | null>(null);
  const [strategyErrors, setStrategyErrors] = useState<Record<number, string>>({});

  function openCreate() {
    setForm(emptyForm());
    setError(null);
  }

  function openEdit(goal: Goal) {
    const deadline = typeof goal.deadline === "string" ? new Date(goal.deadline) : goal.deadline;
    setForm({
      id: goal.id,
      name: goal.name,
      targetAmount: String(goal.targetAmount),
      initialAmount: String(goal.initialAmount),
      deadline: `${deadline.getFullYear()}-${String(deadline.getMonth() + 1).padStart(2, "0")}-${String(
        deadline.getDate()
      ).padStart(2, "0")}`,
    });
    setError(null);
  }

  async function handleSave() {
    if (!form) return;

    const name = form.name.trim();
    if (!name || name.length > MAX_NAME_LENGTH) {
      setError("نام هدف الزامی و کوتاه‌تر از حد مجاز است.");
      return;
    }
    const targetAmount = Number(form.targetAmount);
    if (!Number.isFinite(targetAmount) || targetAmount <= 0 || targetAmount > MAX_GOAL_TARGET_AMOUNT) {
      setError("مبلغ هدف نامعتبر است.");
      return;
    }
    const initialAmount = form.initialAmount ? Number(form.initialAmount) : 0;
    if (!Number.isFinite(initialAmount) || initialAmount < 0 || initialAmount > MAX_GOAL_TARGET_AMOUNT) {
      setError("مبلغ ذخیره‌شده فعلی نامعتبر است.");
      return;
    }
    const deadline = new Date(form.deadline);
    if (Number.isNaN(deadline.getTime())) {
      setError("مهلت هدف نامعتبر است.");
      return;
    }
    // Same day-granularity "past/today both rejected" rule as
    // app/api/goals/route.ts's own POST validation - checked client-side too
    // so a bad submission fails fast, but the API's check remains the real
    // source of truth.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const deadlineDay = new Date(deadline);
    deadlineDay.setHours(0, 0, 0, 0);
    if (deadlineDay.getTime() <= today.getTime()) {
      setError("مهلت هدف باید در آینده باشد.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const isEdit = form.id !== null;
      // The category picker is gone - the goal's free-text name is now
      // considered sufficient. The API contract (app/api/goals/route.ts's
      // POST) still requires a valid category, so new goals always send
      // "other"; PATCH (app/api/goals/[id]/route.ts) never reads body.category
      // at all and supports partial updates, so an edit simply omits the
      // field rather than sending a value that would be silently ignored.
      const payload = isEdit
        ? { name, targetAmount, initialAmount, deadline: form.deadline }
        : { name, category: "other", targetAmount, initialAmount, deadline: form.deadline };
      const res = await fetch(isEdit ? `/api/goals/${form.id}` : "/api/goals", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ذخیره‌سازی.");
      setForm(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    setDeletingId(id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/goals/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در حذف.");
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setDeletingId(null);
      setConfirmingDeleteId(null);
    }
  }

  async function handleStatusChange(id: number, status: "achieved" | "abandoned") {
    setUpdatingStatusId(id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/goals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در بروزرسانی وضعیت.");
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setUpdatingStatusId(null);
    }
  }

  async function handleGenerateStrategy(id: number) {
    setStrategyLoadingId(id);
    setStrategyErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch(`/api/goals/${id}/strategy`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در تولید استراتژی.");
      setStrategies((prev) => ({ ...prev, [id]: data.strategy }));
    } catch (err) {
      setStrategyErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : "خطای ناشناخته",
      }));
    } finally {
      setStrategyLoadingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">هدف‌های مالی</h2>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary shadow-sm shadow-primary/20 transition-transform active:scale-95"
        >
          <PlusIcon className="h-4 w-4" />
          هدف جدید
        </button>
      </div>

      {/* Dedicated route (app/app/savings/page.tsx) - same "entry point is a
          link from a related existing page, not a bottom-nav slot"
          convention as app/app/transfer/page.tsx's own entry link, in
          components/accounts/accounts-manager.tsx's header. */}
      <Link href="/app/savings" className="flex items-center gap-1.5 text-xs font-medium text-accent">
        <PiggyBankIcon className="h-3.5 w-3.5" />
        پس‌انداز
      </Link>

      {deleteError && <p className="rounded-xl bg-warning/10 p-3 text-xs text-warning">{deleteError}</p>}

      {goals.length === 0 ? (
        <EmptyState
          icon={<span className="text-lg">🎯</span>}
          title="هنوز هدفی تعریف نکرده‌اید"
          description="اولین هدفتو تعریف کن تا وضعیت پیشرفتش رو اینجا ببینی."
        />
      ) : (
        <div className="space-y-3">
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              onEdit={() => openEdit(goal)}
              onDelete={() => handleDelete(goal.id)}
              onStatusChange={(status) => handleStatusChange(goal.id, status)}
              deleting={deletingId === goal.id}
              confirmingDelete={confirmingDeleteId === goal.id}
              onRequestDelete={() => setConfirmingDeleteId(goal.id)}
              onCancelDelete={() => setConfirmingDeleteId(null)}
              updatingStatus={updatingStatusId === goal.id}
              strategy={strategies[goal.id]}
              strategyLoading={strategyLoadingId === goal.id}
              strategyError={strategyErrors[goal.id]}
              onGenerateStrategy={() => handleGenerateStrategy(goal.id)}
            />
          ))}
        </div>
      )}

      {form && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => !saving && setForm(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface p-5 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-foreground">{form.id ? "ویرایش هدف" : "هدف جدید"}</h2>
              <button onClick={() => setForm(null)} disabled={saving} aria-label="بستن">
                <XIcon className="h-5 w-5 text-muted" />
              </button>
            </div>

            <label className="block text-xs text-muted">نام هدف</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="مثلاً سفر شمال"
              className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
            />

            <MoneyInput
              label="مبلغ هدف (تومان)"
              value={form.targetAmount}
              onChange={(digits) => setForm({ ...form, targetAmount: digits })}
            />

            <MoneyInput
              label="مبلغ ذخیره‌شده فعلی (تومان، اختیاری)"
              value={form.initialAmount}
              onChange={(digits) => setForm({ ...form, initialAmount: digits })}
            />

            <label className="mt-4 block text-xs text-muted">مهلت</label>
            <JalaliDatePicker
              value={form.deadline}
              onChange={(deadline) => setForm({ ...form, deadline })}
              minDate={tomorrowDate()}
            />

            {error && <p className="mt-3 text-xs text-warning">{error}</p>}

            <button
              onClick={handleSave}
              disabled={saving}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary disabled:opacity-50"
            >
              {saving ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
              ذخیره
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
