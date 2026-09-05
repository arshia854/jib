import "server-only";
import { chatCompletion, AI_PROVIDER, type TokenUsage } from "@/lib/nvidia-ai";
import { extractJson } from "@/lib/ai/parse-transaction";
import { getSpendingSummary } from "@/lib/analytics/spending-summary";
import type { GoalFeasibility, FeasibilityStatus } from "@/lib/goals/feasibility";
import { formatToman, formatJalaaliDate } from "@/lib/format";
import { logger } from "@/lib/observability/logger";
import { getRequestId } from "@/lib/observability/request-context";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

// Minimum number of validated actions a response must retain to be
// returned at all. A response left with fewer (after dropping individually
// malformed actions - see sanitizeGoalStrategyAction) is thrown rather than
// returned as a thin/degraded strategy - same "fail loud rather than
// silently return something misleadingly thin" precedent as
// lib/analytics/spending-summary.ts's recurring-expense lookback-mismatch
// throw.
const MIN_STRATEGY_ACTIONS = 3;
const MAX_STRATEGY_ACTIONS = 5;

export type GoalStrategyActionType = "reduce_expense" | "increase_savings" | "extra_income";

const GOAL_STRATEGY_ACTION_TYPES: readonly GoalStrategyActionType[] = [
  "reduce_expense",
  "increase_savings",
  "extra_income",
];

export interface GoalStrategyAction {
  type: GoalStrategyActionType;
  title: string; // short Persian action title
  description: string; // one or two Persian sentences, concrete and specific
  // Present only for actions referencing a real category/merchant/amount
  // from this module's own grounding data (see buildSystemPrompt) - never a
  // number invented by the model. Omitted for actions with no single
  // traceable source figure.
  relatedAmount?: number;
  priority: number; // 1 = highest priority, ascending
}

export interface GoalStrategy {
  actions: GoalStrategyAction[]; // 3-5 entries
  summary: string; // one short Persian sentence framing the overall approach
  generatedAt: string; // ISO timestamp
}

export interface GoalStrategyGoalInput {
  name: string;
  targetAmount: number;
  initialAmount: number;
  deadline: Date;
}

// Persian labels for GoalFeasibility.feasibilityStatus - the same wording
// components/goals/goals-manager.tsx's own FEASIBILITY_TONE map already
// surfaces to the user on the goal card, reused verbatim here so the AI's
// grounding data describes the goal's status the same way the user already
// sees it, rather than a second, possibly-inconsistent phrasing.
const FEASIBILITY_STATUS_LABEL: Record<FeasibilityStatus, string> = {
  on_track: "در مسیر",
  needs_adjustment: "نیاز به تعدیل",
  unrealistic: "غیرواقعی",
};

// Raw shape of one action in the AI's JSON response - untrusted at this
// point, same spirit as RawParsedTransaction in lib/ai/parse-transaction.ts.
interface RawGoalStrategyAction {
  type?: string;
  title?: string;
  description?: string;
  relatedAmount?: number | null;
}

interface RawGoalStrategy {
  actions: unknown[];
  summary?: string;
}

// Only checks `actions` is present as an array - each element is validated
// individually by sanitizeGoalStrategyAction below, and `summary` is
// defaulted rather than gated here (see generateGoalStrategy's own comment
// on that choice).
function isRawGoalStrategy(value: unknown): value is RawGoalStrategy {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.actions);
}

function isGoalStrategyActionType(value: unknown): value is GoalStrategyActionType {
  return typeof value === "string" && (GOAL_STRATEGY_ACTION_TYPES as readonly string[]).includes(value);
}

// Validates and sanitizes one raw action. type/title/description must all
// be present and well-formed or the *entire* action is dropped (same
// all-or-nothing gate as isRawParsedTransaction in parse-transaction.ts) -
// these are the fields nothing downstream can safely default.
// relatedAmount is treated differently: it's optional and purely additive
// (a UI nicety a caller can render around, not something the rest of the
// action depends on), so an invalid value (not a positive finite number) is
// dropped on its own, keeping the rest of an otherwise-valid action rather
// than rejecting it outright - documented behavior, see this module's own
// test file for the exact case this covers.
function sanitizeGoalStrategyAction(raw: unknown): Omit<GoalStrategyAction, "priority"> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as RawGoalStrategyAction;

  if (!isGoalStrategyActionType(r.type)) return undefined;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return undefined;
  const description = typeof r.description === "string" ? r.description.trim() : "";
  if (!description) return undefined;

  const relatedAmount =
    typeof r.relatedAmount === "number" && Number.isFinite(r.relatedAmount) && r.relatedAmount > 0
      ? r.relatedAmount
      : undefined;

  return { type: r.type, title, description, ...(relatedAmount !== undefined ? { relatedAmount } : {}) };
}

function buildSystemPrompt(
  goal: GoalStrategyGoalInput,
  feasibility: GoalFeasibility,
  topDiscretionaryCategories: { name: string; total: number }[],
  recurringExpenses: { description: string; averageAmount: number }[]
): string {
  const discretionaryLines = topDiscretionaryCategories.length
    ? topDiscretionaryCategories.map((c) => `- ${c.name}: ${formatToman(c.total)}`).join("\n")
    : "- (داده‌ای ثبت نشده)";

  const recurringLines = recurringExpenses.length
    ? recurringExpenses.map((r) => `- ${r.description}: ${formatToman(r.averageAmount)}`).join("\n")
    : "- (داده‌ای ثبت نشده)";

  const completionLine =
    feasibility.projectedCompletionMonths !== null
      ? `تخمین زمان رسیدن به هدف با روند فعلی: ${feasibility.projectedCompletionMonths} ماه`
      : "با روند فعلی، این هدف قابل دستیابی نیست.";

  return `شما دستیار برنامه‌ریزی مالی اپلیکیشن «جیب» هستید. برای هدف مالی زیر، یک استراتژی عملی و مشخص برای کاربر تولید کن که کاملاً بر اساس داده‌های واقعی زیر باشد، نه حدس یا اطلاعات عمومی. فقط یک شیء JSON با دقیقاً همین کلیدها برگردان، بدون هیچ متن یا توضیح اضافه و بدون markdown:

{"actions": [{"type": "reduce_expense" | "increase_savings" | "extra_income", "title": string, "description": string, "relatedAmount": number | null}], "summary": string}

هدف کاربر:
نام: ${goal.name}
مبلغ هدف: ${formatToman(goal.targetAmount)}
مبلغ ذخیره‌شده فعلی: ${formatToman(goal.initialAmount)}
مهلت: ${formatJalaaliDate(goal.deadline)}

وضعیت امکان‌پذیری هدف:
وضعیت: ${FEASIBILITY_STATUS_LABEL[feasibility.feasibilityStatus]}
مبلغ ماهانه مورد نیاز برای رسیدن به هدف: ${formatToman(feasibility.requiredMonthlyAmount)}
میانگین پس‌انداز واقعی ماهانه کاربر (بر اساس ۳ ماه اخیر): ${formatToman(feasibility.actualMonthlyAverage)}
کمبود ماهانه (مبلغ مورد نیاز منهای میانگین واقعی): ${formatToman(feasibility.gap)}
${completionLine}

دسته‌های هزینه غیرضروری کاربر در ماه جاری (فقط از همین لیست برای اقدام‌های reduce_expense استفاده کن):
${discretionaryLines}

هزینه‌های تکرارشونده کاربر (فقط از همین لیست برای اقدام‌های reduce_expense استفاده کن):
${recurringLines}

قوانین:
- بین ۳ تا ۵ اقدام (action) پیشنهاد بده.
- type هر اقدام باید دقیقاً یکی از "reduce_expense" | "increase_savings" | "extra_income" باشد.
- title یک عنوان کوتاه فارسی و description یک یا دو جمله فارسی مشخص و عملی است.
- برای اقدام‌های نوع reduce_expense، فقط از نام دسته‌ها/هزینه‌های تکرارشونده‌ای که در لیست‌های بالا آمده استفاده کن - هرگز یک دسته یا فروشنده‌ای که در آن لیست‌ها نیست را نام نبر.
- relatedAmount را فقط وقتی پر کن که اقدام مستقیماً به یکی از مبلغ‌های واقعی لیست‌های بالا اشاره دارد؛ همان عدد واقعی را (نه عددی که خودت حدس می‌زنی) در آن بگذار. در غیر این صورت relatedAmount را null بگذار.
- هرگز عددی که در داده‌های بالا نیامده را در description یا relatedAmount اختراع نکن.
- summary یک جمله کوتاه فارسی است که رویکرد کلی استراتژی را خلاصه می‌کند.`;
}

/**
 * Generates a 3-5 action, Persian, AI-produced strategy for one goal -
 * grounded in that goal's already-computed GoalFeasibility (see
 * lib/goals/feasibility.ts, reused not recomputed) and the user's real
 * discretionary-spending/recurring-expense data (reused from
 * lib/analytics/spending-summary.ts) - the model is never allowed to invent
 * a category, merchant, or figure that isn't in that grounding data (see
 * buildSystemPrompt's own rules).
 *
 * No caching/persistence - generates fresh on every call, per this phase's
 * own scope. A malformed/too-thin AI response throws a single user-facing
 * Persian error message rather than returning a degraded strategy - see
 * MIN_STRATEGY_ACTIONS's own doc comment.
 */
export async function generateGoalStrategy(
  goal: GoalStrategyGoalInput,
  feasibility: GoalFeasibility,
  userId: number
): Promise<GoalStrategy> {
  const userFacingError = () => new Error("در تولید استراتژی خطایی رخ داد. دوباره تلاش کنید.");

  // getSpendingSummary computes far more than this feature needs (total
  // balance, recent transactions, cash-flow trend, ...) - reused anyway
  // rather than hand-rolling a narrower query: this runs once per button
  // press (not on every chat message like getSpendingSummary's other
  // caller), so the extra cost is negligible, and reusing it keeps this
  // feature's discretionary/recurring figures in lockstep with that file's
  // own isTransfer-exclusion and aggregation rules instead of a second,
  // possibly-drifting copy of them.
  const spendingSummary = await getSpendingSummary(userId);
  const { topDiscretionaryCategories, recurringExpenses } = spendingSummary;

  const aiCallStartedAt = Date.now();
  let content: string;
  let usage: TokenUsage | undefined;
  try {
    content = await chatCompletion(
      [
        {
          role: "system",
          content: buildSystemPrompt(goal, feasibility, topDiscretionaryCategories, recurringExpenses),
        },
        { role: "user", content: "استراتژی را تولید کن." },
      ],
      {
        json: true,
        onUsage: (u) => {
          usage = u;
        },
      }
    );
    logger.info(
      {
        requestId: getRequestId(),
        route: "goals/strategy",
        userId,
        duration: Date.now() - aiCallStartedAt,
        provider: AI_PROVIDER,
        usage,
      },
      "AI call succeeded"
    );
  } catch (error) {
    reportError({
      errorType: ERROR_TYPES.AI_ERROR,
      route: "goals/strategy",
      userId,
      duration: Date.now() - aiCallStartedAt,
      message: error instanceof Error ? error.message : "AI call failed",
      error,
      context: { provider: AI_PROVIDER, goalName: goal.name },
    });
    throw userFacingError();
  }

  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch (extractError) {
    reportError({
      errorType: ERROR_TYPES.PARSER_ERROR,
      route: "goals/strategy",
      userId,
      message: extractError instanceof Error ? extractError.message : "Failed to extract JSON from AI response",
      error: extractError,
      context: { contentLength: content.length },
    });
    throw userFacingError();
  }

  if (!isRawGoalStrategy(parsed)) {
    const validationError = new Error("AI response failed goal-strategy shape validation");
    reportError({
      errorType: ERROR_TYPES.PARSER_ERROR,
      route: "goals/strategy",
      userId,
      message: validationError.message,
      error: validationError,
      context: { contentLength: content.length },
    });
    throw userFacingError();
  }

  // Malformed actions are dropped individually (sanitizeGoalStrategyAction)
  // - only a response left with fewer than MIN_STRATEGY_ACTIONS surviving
  // actions is treated as a hard failure. Priority is then assigned purely
  // from surviving order (1 = highest), ignoring whatever the model itself
  // might separately claim for it: the model's own array order already
  // encodes its priority ranking, and renumbering sequentially guarantees a
  // clean, gap-free 1..n sequence regardless of how the model behaved,
  // rather than trusting a second, separately-hallucinated number that
  // could disagree with the array order or repeat/skip values.
  const sanitized = parsed.actions
    .map(sanitizeGoalStrategyAction)
    .filter((a): a is Omit<GoalStrategyAction, "priority"> => a !== undefined)
    .slice(0, MAX_STRATEGY_ACTIONS);

  if (sanitized.length < MIN_STRATEGY_ACTIONS) {
    const validationError = new Error(
      `AI response had only ${sanitized.length} valid action(s), below the minimum of ${MIN_STRATEGY_ACTIONS}`
    );
    reportError({
      errorType: ERROR_TYPES.PARSER_ERROR,
      route: "goals/strategy",
      userId,
      message: validationError.message,
      error: validationError,
      context: { contentLength: content.length, validActionCount: sanitized.length },
    });
    throw userFacingError();
  }

  const actions: GoalStrategyAction[] = sanitized.map((action, index) => ({ ...action, priority: index + 1 }));

  // summary is additive framing text, not a field the rest of the strategy
  // depends on the way actions does - a missing/empty one falls back to a
  // generic Persian sentence rather than discarding an otherwise-valid set
  // of 3-5 actions over it (documented judgment call, distinct from the
  // "throw below MIN_STRATEGY_ACTIONS" rule above, which only ever governs
  // `actions`).
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : "برای رسیدن به این هدف، اقدام‌های زیر را در نظر بگیرید.";

  return { actions, summary, generatedAt: new Date().toISOString() };
}
