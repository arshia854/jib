import "server-only";
import { chatCompletion, AI_PROVIDER, type TokenUsage, type ResponseMeta } from "@/lib/nvidia-ai";
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

// Dedicated chatCompletion({json: true}) output budget for this call only -
// deliberately NOT lib/nvidia-ai.ts's own JSON_EXTRACTION_MAX_TOKENS (1500),
// which that file's own comment documents as sized for a single flat
// transaction object or a one-boolean intent check. This schema is a whole
// different order of size: up to MAX_STRATEGY_ACTIONS actions (each with
// type/title/description/relatedAmount) plus summary, monthlyActionTitle,
// monthlyActionDescription, and inflationNote, all in Persian prose (which
// tokenizes noticeably less densely per sentence than English on most
// models). Under the shared 1500 cap this response could be cut off
// mid-object, which JSON.parse (via extractJson) has no tolerance for -
// this was found to be the cause of goal-strategy generation intermittently
// failing with "استراتژی ساخته نشد" in production.
//
// Raised 3000 -> 6000 on 2026-09-27: max_tokens also covers the model's
// reasoning, which chat_template_kwargs doesn't actually switch off for
// this prompt (see lib/nvidia-ai.ts). A probe of 5 real calls with this
// exact prompt spent 1671-3000 reasoning tokens before the ~850-token JSON
// answer; 3 of the 5 hit the 3000 cap (finish_reason "length") with the
// JSON cut off or never started. 6000 leaves ~5000 for reasoning on top of
// a worst-case answer, while still bounding cost/abuse the same way
// JSON_EXTRACTION_MAX_TOKENS does for its own callers (SEC-6).
const GOAL_STRATEGY_JSON_MAX_TOKENS = 6000;

// Dedicated chatCompletion() timeout for this call only - deliberately NOT
// lib/nvidia-ai.ts's own NVIDIA_REQUEST_TIMEOUT_MS default (30s), for the
// same reason GOAL_STRATEGY_JSON_MAX_TOKENS isn't JSON_EXTRACTION_MAX_TOKENS:
// this call's completion is a whole different order of size. chatCompletion()
// is non-streaming, so fetch() doesn't resolve until ArvanCloud has finished
// generating the full completion (see NVIDIA_REQUEST_TIMEOUT_MS's own
// comment) - a bigger token budget directly means more wall-clock time
// before fetch() resolves, not just a bigger response body. The 30s shared
// default was sized against the *original*, smaller JSON_EXTRACTION_MAX_TOKENS
// and was never revisited when this call's own budget was raised to 3000 -
// production then hit it directly: AI_ERROR logs for this exact route with
// duration: 30002 (the timeout firing, not a slow-but-real response) and the
// literal "کندی پاسخ" (slow-response) message, twice in one user's retry
// attempt. 60s is double the shared default, matched to
// GOAL_STRATEGY_JSON_MAX_TOKENS also being exactly double
// JSON_EXTRACTION_MAX_TOKENS (3000 vs 1500) - the same
// "generous multiple of a realistic generation time" margin the original 30s
// was reasoned from (see NVIDIA_REQUEST_TIMEOUT_MS's comment), scaled to
// match the larger cap rather than assumed to still hold unchanged. Left as
// a caller-specific override (not a blanket raise of the shared default) so
// the smaller/faster callers (transaction parsing, intent detection) still
// fail in a bounded, responsive 30s when something is actually stuck,
// instead of a genuinely-hung request taking twice as long to surface for
// them too.
//
// Raised 60s -> 90s alongside the 6000-token budget above: the same probe
// measured ~115 output tokens/s, so a response that uses the whole budget
// takes ~52s of generation alone.
const GOAL_STRATEGY_TIMEOUT_MS = 90_000;

// Months remaining until a goal's deadline beyond which idle cash sitting
// unallocated toward it is judged a meaningful inflation-erosion concern
// worth surfacing (see GoalStrategy.inflationNote). A rule-of-thumb figure
// (~1 year) - same "no calibration data exists for this yet" caveat as
// FEASIBILITY_ON_TRACK_RATIO et al. in lib/goals/feasibility.ts - not a
// magic number inlined at the comparison site.
export const INFLATION_HEDGE_HORIZON_MONTHS = 12;

// Defense-in-depth against buildSystemPrompt's own instructions not being
// followed: inflationNote must stay at the general "asset class" level and
// never name a specific instrument (see this module's own prompt rules and
// the feature's product requirement that Jib, not being a licensed
// financial advisor, never recommend a specific investment). Rather than
// trusting prompt compliance alone, any note containing one of these
// substrings is dropped entirely (see sanitizeInflationNote) - same
// "sanitize the model's output, don't just ask nicely" spirit as
// sanitizeGoalStrategyAction's relatedAmount handling below. Deliberately a
// substring/keyword check, not exhaustive - it catches the literal
// instrument names this feature must never surface, not every conceivable
// phrasing.
//
// Each entry is picked to be unambiguous on its own - a bare "ارز" (generic
// "currency") or "سهم" (ordinary "share/portion", e.g. this very module's
// own "سهم این هدف" phrasing) would false-positive on completely unrelated,
// necessary vocabulary like "ارزش" ("value" - the note has to talk about
// real value eroding) or "سهم بیشتری از پس‌انداز" ("a bigger share of
// savings"). Same reasoning ruled out a bare "صندوق"/"اوراق" (generic
// "box/fund" and "papers", e.g. "صندوق پس‌انداز" = a savings jar, not an
// investment product) in favor of the fuller, unambiguous phrases below.
const FORBIDDEN_INFLATION_INSTRUMENT_KEYWORDS = [
  "طلا",
  "سکه",
  "دلار",
  "یورو",
  "پوند",
  "درهم",
  "سهام",
  "بورس",
  "صندوق سرمایه‌گذاری",
  "اوراق قرضه",
  "اوراق بهادار",
  "بیت‌کوین",
  "بیتکوین",
  "کریپتو",
  "رمزارز",
  "ملک",
  "مسکن",
];

// Fallback used when the model's monthlyActionTitle/Description is
// missing/malformed - see buildMonthlyAction. Unlike the actions array
// (a too-thin response is a hard failure - MIN_STRATEGY_ACTIONS), the
// monthly action's one number (amount) is always deterministic
// (feasibility.requiredMonthlyAmount, never LLM-authored - see
// buildMonthlyAction), so a missing/bad title or description degrades to
// this generic wording rather than failing the whole strategy over
// phrasing alone.
const DEFAULT_MONTHLY_ACTION_TITLE = "پس‌انداز ماهانه مشخص";
function defaultMonthlyActionDescription(amount: number): string {
  return `هر ماه ${formatToman(amount)} برای این هدف کنار بگذار.`;
}

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

// Current progress toward the goal, computed deterministically from the
// caller's own inputs (see computeProgress) - never LLM-authored. Amounts
// like this are exactly the kind of arithmetic this module elsewhere
// refuses to let the model touch (see buildSystemPrompt's "never invent a
// number" rule for actions) - computing it in code guarantees it's always
// present and always correct, rather than hoping a longer prompt makes the
// model state it accurately every time.
export interface GoalStrategyProgress {
  currentAmount: number; // initialAmount + the goal's share of the user's account balance
  targetAmount: number;
  percentage: number; // 0-100, rounded
}

// A single, guaranteed-present concrete monthly action - distinct from the
// free-form `actions` list above so the UI always has one fixed-position
// "save this much, this way" instruction to render regardless of what the
// model's `actions` array happened to contain. `amount` is always
// feasibility.requiredMonthlyAmount (deterministic, see buildMonthlyAction)
// - only title/description are model-authored.
export interface GoalStrategyMonthlyAction {
  title: string;
  description: string;
  amount: number;
}

export interface GoalStrategy {
  actions: GoalStrategyAction[]; // 3-5 entries
  summary: string; // one short Persian sentence framing the overall approach
  progress: GoalStrategyProgress;
  monthlyAction: GoalStrategyMonthlyAction;
  // Present only when the goal's deadline is far enough out
  // (INFLATION_HEDGE_HORIZON_MONTHS) that idle cash meaningfully loses real
  // value over that horizon - null otherwise, regardless of what the model
  // returns (see generateGoalStrategy). Deliberately kept at the general
  // "asset class" level, framed as something to look into rather than a
  // recommendation - never a specific instrument (see
  // FORBIDDEN_INFLATION_INSTRUMENT_KEYWORDS/sanitizeInflationNote).
  inflationNote: string | null;
  generatedAt: string; // ISO timestamp
}

export interface GoalStrategyGoalInput {
  name: string;
  targetAmount: number;
  initialAmount: number;
  deadline: Date;
  // This goal's share of the user's total account balance - mirrors
  // GoalFeasibilityInput.availableBalance (lib/goals/feasibility.ts) exactly
  // (same per-goal apportionment, same "0 for a goal with no meaningful
  // share to attribute" convention) so the strategy's stated progress never
  // disagrees with the feasibility numbers computed from the same figure.
  availableBalance: number;
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
  monthlyActionTitle?: string;
  monthlyActionDescription?: string;
  inflationNote?: string | null;
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

// Deterministic - see GoalStrategyProgress's own doc comment on why this
// isn't left to the model. currentAmount combines initialAmount (the
// user's manually-recorded starting savings) with availableBalance (this
// goal's share of tracked account balances) because that's exactly the sum
// feasibility.ts's own remainingAmount formula subtracts from targetAmount
// (see computeGoalFeasibility) - counting only availableBalance here would
// under-state progress for any goal that also has a nonzero initialAmount
// and would disagree with the feasibility numbers shown right alongside it.
function computeProgress(goal: GoalStrategyGoalInput): GoalStrategyProgress {
  const currentAmount = goal.initialAmount + goal.availableBalance;
  const percentage =
    goal.targetAmount > 0 ? Math.min(100, Math.max(0, Math.round((currentAmount / goal.targetAmount) * 100))) : 0;
  return { currentAmount, targetAmount: goal.targetAmount, percentage };
}

// amount is always feasibility.requiredMonthlyAmount - never whatever the
// model might have echoed back, even if it happened to match (there is no
// field for it in RawGoalStrategy at all, see buildSystemPrompt - the model
// is never asked for a number here, only phrasing). title/description fall
// back to a generic-but-still-concrete default (still stating the real
// amount) when missing/malformed, rather than failing the whole strategy -
// see DEFAULT_MONTHLY_ACTION_TITLE's own doc comment.
function buildMonthlyAction(raw: RawGoalStrategy, feasibility: GoalFeasibility): GoalStrategyMonthlyAction {
  const amount = Math.max(0, feasibility.requiredMonthlyAmount);
  const title = typeof raw.monthlyActionTitle === "string" ? raw.monthlyActionTitle.trim() : "";
  const description = typeof raw.monthlyActionDescription === "string" ? raw.monthlyActionDescription.trim() : "";
  return {
    title: title || DEFAULT_MONTHLY_ACTION_TITLE,
    description: description || defaultMonthlyActionDescription(amount),
    amount,
  };
}

// null when the field is absent/blank/non-string, or when it contains one
// of FORBIDDEN_INFLATION_INSTRUMENT_KEYWORDS - see that constant's own doc
// comment. `applicable` is passed in rather than re-derived here so the
// single source of truth for the threshold comparison
// (monthsRemaining > INFLATION_HEDGE_HORIZON_MONTHS) lives once, in
// generateGoalStrategy, and a note is force-dropped when it doesn't hold
// regardless of what the model returned (buildSystemPrompt never even asks
// for one below the threshold, but this is enforced here too rather than
// trusting that instruction alone).
function sanitizeInflationNote(raw: RawGoalStrategy, applicable: boolean): string | null {
  if (!applicable) return null;
  if (typeof raw.inflationNote !== "string") return null;
  const note = raw.inflationNote.trim();
  if (!note) return null;
  if (FORBIDDEN_INFLATION_INSTRUMENT_KEYWORDS.some((keyword) => note.includes(keyword))) return null;
  return note;
}

function buildSystemPrompt(
  goal: GoalStrategyGoalInput,
  feasibility: GoalFeasibility,
  topDiscretionaryCategories: { name: string; total: number }[],
  recurringExpenses: { description: string; averageAmount: number }[],
  progress: GoalStrategyProgress,
  inflationHedgeApplicable: boolean
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

  // Only requested from the model, and only ever kept, when
  // inflationHedgeApplicable (generateGoalStrategy's own
  // monthsRemaining > INFLATION_HEDGE_HORIZON_MONTHS check) holds - the
  // schema line and rule paragraph below both branch on it so a
  // below-threshold goal is explicitly told to omit it rather than just
  // hoping the model infers that from silence.
  const inflationNoteRule = inflationHedgeApplicable
    ? `- چون مهلت این هدف بیش از ${INFLATION_HEDGE_HORIZON_MONTHS} ماه است، در inflationNote یک یا دو جمله کلی درباره این بگذار که نگه‌داشتن این مبلغ به‌صورت نقد راکد در این بازه زمانی می‌تواند از نظر ارزش واقعی افت کند. در این جمله هرگز نام یک دارایی یا محصول خاص (مثل طلا، سکه، دلار، ارز، سهام خاص، صندوق سرمایه‌گذاری خاص) را نبر - فقط در سطح کلی از «دارایی‌های مقاوم در برابر تورم» یا عبارتی مشابه صحبت کن، و آن را نه به‌عنوان توصیه قطعی بلکه چیزی که ارزش بررسی بیشتر یا مشورت با یک مشاور مالی را دارد مطرح کن.`
    : "- چون مهلت این هدف کوتاه‌تر از آن است که نگرانی تورمی معناداری داشته باشد، inflationNote را null بگذار.";

  return `تو «جیب» هستی؛ یک رفیق باهوش و مالی‌آگاه که حواسش به وضعیت مالی کاربره و کمکش می‌کنه به هدف‌هاش برسه - نه یک ربات رسمی، نه یک مربی شعاری و نه یک ناظر سرزنشگر. هر متنی که در title، description و summary تولید می‌کنی باید همین شخصیت را داشته باشد:
- همیشه با «تو» به کاربر خطاب کن، نه «شما».
- قضاوت نکن، توصیف کن - مثلاً به‌جای «زیادی خرج کردی» بگو «خرجت از میانگین بیشتر شده».
- تا جایی که به داده‌های زیر مربوط می‌شود، ساختار «واقعیت ← تحلیل ← پیشنهاد» را رعایت کن: اول یک عدد یا واقعیت مشخص از همین داده‌ها، بعد دلیل یا زمینه‌اش در صورت وجود، و در آخر پیشنهاد عملی.
- اگر وضعیت امکان‌پذیری هدف «غیرواقعی» است، این را رک و بر اساس کمبود ماهانه واقعی توصیف کن - نه با دلگرمی الکی نرمش کن، نه با لحن سرزنشگر بگو.
- اگر وضعیت «در مسیر» است، از تعریف و تشویق اغراق‌آمیز پرهیز کن و لحنی آرام و واقع‌بینانه داشته باش.
- برای اقدام‌های reduce_expense لحنی ساده و عملی داشته باش، نه دراماتیک یا نگران‌کننده.
- هیچ شوخی، ایموجی یا لحن غیرجدی به کار نبر؛ این یک استراتژی مالی است، نه یک پیام گپ.
- اگر می‌خواهی در یک جمله بامزه یا باحال باشی، این بامزگی باید از یک مشاهده‌ی دقیق و مشخص درباره‌ی داده‌های واقعی همین هدف بیاید - همان اعداد امکان‌پذیری، دسته‌های هزینه غیرضروری یا هزینه‌های تکرارشونده‌ای که پایین‌تر آمده - نه از یک جک یا شعار کلی که برای هر کاربر و هر هدف دیگری هم جواب بدهد: اگه بشه یه جمله رو از یک استراتژی دیگه هم برداری و همون اثر رو بزنه، یعنی جمله از داده‌های این هدف نیومده - باید حذفش کنی یا دوباره بر اساس همین اعداد بسازی.
- وقتی وضعیت امکان‌پذیری «در مسیر» است، summary می‌تواند - به‌عنوان یک استثنای محدود بر ترتیب «واقعیت ← تحلیل ← پیشنهاد» بالا - با یک جمله‌ی جسور، بامزه و مشخص درباره‌ی همین پیشرفت شروع شود (همان حال‌وهوای نزدیک‌شدن به هدف)، اما فقط پیش از عدد یا پیش‌بینی مشخص پیشرفت، نه به‌جای آن؛ همیشه اول تکه‌ی بامزه، بعد همان عدد واقعی، در همان جمله یا جمله‌ی بعدی.
- همین‌طور، وقتی یک اقدام از نوع reduce_expense یکی از دسته‌های هزینه غیرضروری بالا را هدف می‌گیرد که فرصت صرفه‌جویی واقعی و محسوسی در آن دیده می‌شود، description همان اقدام هم می‌تواند به همین ترتیب - و با همان استثنای محدود بالا - باز شود: اول یک مشاهده‌ی بامزه و مشخص درباره‌ی همان عدد واقعی آن دسته، بعد مبلغ یا پیشنهاد مشخص.
- این دو مورد بالا تنها استثنای قانون «هیچ شوخی، ایموجی یا لحن غیرجدی به کار نبر» هستند؛ وقتی وضعیت امکان‌پذیری «غیرواقعی» یا «نیاز به تعدیل» است، هیچ لحن جسور یا بامزه‌ای به‌کار نبر و دقیقاً همان لحن ساده، رک و بدون سرزنشی را که در بالا گفته شد حفظ کن - آنجا شوخی همچنان کاملاً ممنوع است.
- در هر فیلد (title، description یا summary) حداکثر یک تکه‌ی بامزه/جسور بگذار - هیچ‌وقت دو یا چند تا را روی هم نگذار، و هیچ‌وقت بعدش توضیح نده که چرا بامزه بود.

برای هدف مالی زیر یک استراتژی عملی و مشخص تولید کن که کاملاً بر اساس داده‌های واقعی زیر باشد، نه حدس یا اطلاعات عمومی. فقط یک شیء JSON با دقیقاً همین کلیدها برگردان، بدون هیچ متن یا توضیح اضافه و بدون markdown:

{"actions": [{"type": "reduce_expense" | "increase_savings" | "extra_income", "title": string, "description": string, "relatedAmount": number | null}], "summary": string, "monthlyActionTitle": string, "monthlyActionDescription": string, "inflationNote": string | null}

هدف کاربر:
نام: ${goal.name}
مبلغ هدف: ${formatToman(goal.targetAmount)}
مبلغ ذخیره‌شده فعلی: ${formatToman(goal.initialAmount)}
موجودی فعلی حساب‌های کاربر که سهم این هدف است: ${formatToman(goal.availableBalance)}
مجموع پیشرفت تا این لحظه: ${formatToman(progress.currentAmount)} (${progress.percentage} درصد از مبلغ هدف)
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
- summary یک جمله کوتاه فارسی است که رویکرد کلی استراتژی را خلاصه می‌کند و می‌تواند به مجموع پیشرفت تا این لحظه اشاره کند، بدون این‌که عدد یا درصد دیگری غیر از همان‌هایی که بالا آمده اختراع کند.
- monthlyActionTitle یک عنوان کوتاه فارسی و monthlyActionDescription یک یا دو جمله فارسی است که یک اقدام مشخص و عملی برای پس‌انداز ماهانه به‌سمت این هدف پیشنهاد می‌دهد (مثلاً بر چه اساسی و به چه شکلی کنار گذاشته شود) - بر اساس مبلغ ماهانه مورد نیاز و میانگین پس‌انداز واقعی بالا. لازم نیست خودت عددی در این متن بنویسی؛ مبلغ دقیق جداگانه و به‌صورت خودکار نمایش داده می‌شود.
${inflationNoteRule}`;
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
 * Besides the free-form `actions` list, the returned GoalStrategy always
 * carries three fixed-position, structured fields rather than relying on a
 * longer prompt to reliably weave everything into prose every time:
 * `progress` (current balance vs. target, amount + percentage - computed
 * deterministically in code, never LLM arithmetic), `monthlyAction` (one
 * concrete monthly figure, always feasibility.requiredMonthlyAmount, with
 * model-authored phrasing only), and `inflationNote` (present only when
 * feasibility.monthsRemaining exceeds INFLATION_HEDGE_HORIZON_MONTHS,
 * sanitized against naming a specific instrument - see
 * sanitizeInflationNote).
 *
 * No caching/persistence - generates fresh on every call, per this phase's
 * own scope. A malformed/too-thin AI response throws a single user-facing
 * Persian error message rather than returning a degraded strategy - see
 * MIN_STRATEGY_ACTIONS's own doc comment. monthlyAction/inflationNote never
 * trigger that failure on their own - see their own builder functions.
 */
export async function generateGoalStrategy(
  goal: GoalStrategyGoalInput,
  feasibility: GoalFeasibility,
  userId: number
): Promise<GoalStrategy> {
  const userFacingError = () => new Error("استراتژی ساخته نشد، دوباره تلاش کن.");

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

  const progress = computeProgress(goal);
  const inflationHedgeApplicable = feasibility.monthsRemaining > INFLATION_HEDGE_HORIZON_MONTHS;

  const aiCallStartedAt = Date.now();
  let content: string;
  let usage: TokenUsage | undefined;
  let responseMeta: ResponseMeta | undefined;
  try {
    content = await chatCompletion(
      [
        {
          role: "system",
          content: buildSystemPrompt(
            goal,
            feasibility,
            topDiscretionaryCategories,
            recurringExpenses,
            progress,
            inflationHedgeApplicable
          ),
        },
        { role: "user", content: "استراتژی را تولید کن." },
      ],
      {
        json: true,
        maxTokens: GOAL_STRATEGY_JSON_MAX_TOKENS,
        timeoutMs: GOAL_STRATEGY_TIMEOUT_MS,
        onUsage: (u) => {
          usage = u;
        },
        onResponseMeta: (meta) => {
          responseMeta = meta;
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
        ...responseMeta,
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
      context: { contentLength: content.length, ...responseMeta },
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
      context: { contentLength: content.length, ...responseMeta },
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
      context: { contentLength: content.length, validActionCount: sanitized.length, ...responseMeta },
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
      : "برای رسیدن به این هدف، این اقدام‌ها رو در نظر بگیر.";

  const monthlyAction = buildMonthlyAction(parsed, feasibility);
  const inflationNote = sanitizeInflationNote(parsed, inflationHedgeApplicable);

  return { actions, summary, progress, monthlyAction, inflationNote, generatedAt: new Date().toISOString() };
}
