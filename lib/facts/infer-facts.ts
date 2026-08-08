import { prisma } from "@/lib/prisma";
import { setInferredFact } from "./user-facts";

// Rule-based (no LLM) inference of the inferable facts in
// lib/facts/known-facts.ts, from a user's own transaction/category history.
// Same fast-path-before-AI philosophy as lib/bank/ and lib/merchant-lookup.ts:
// plain deterministic checks, no model call, safe to re-run any time (every
// write below goes through setInferredFact, which upserts or no-ops - never
// throws on a stale re-run). Not wired into any request path - see
// inferFactsForUser's own doc comment.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(from: Date, days: number): Date {
  return new Date(from.getTime() - days * MS_PER_DAY);
}

/** Population coefficient of variation (stdev / mean) - 0 for an empty or all-zero input, so a caller never has to special-case that before comparing against a threshold. */
function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

interface DatedAmount {
  amount: number;
  date: Date;
}

async function getExpensesByCategoryName(userId: number, categoryName: string, since: Date): Promise<DatedAmount[]> {
  return prisma.transaction.findMany({
    where: { userId, type: "expense", date: { gte: since }, category: { name: categoryName } },
    select: { amount: true, date: true },
    orderBy: { date: "asc" },
  });
}

// ---- has_car ----
//
// Category names below must match Category.name values actually seeded by
// DEFAULT_CATEGORIES (prisma/seed.ts): حمل‌ونقل (Transport) > بنزین (Fuel).
// There is no separate parking/vehicle-maintenance subcategory in this
// project's seeded categories, so بنزین is the only usable signal - the
// sibling "تاکسی و اسنپ" subcategory is deliberately excluded since taxi/
// Snapp spending is, if anything, a weak signal *against* car ownership.
//
// Presence is much stronger evidence than absence here: someone might pay
// for gas in cash without logging it, fill up rarely, or drive a car that
// isn't theirs. So this only ever infers "true" - "false" is left unset
// entirely rather than guessed from a lack of بنزین transactions.
const FUEL_CATEGORY_NAME = "بنزین";
const HAS_CAR_LOOKBACK_DAYS = 90;
// More than a single one-off purchase (e.g. a gas can for a generator) is
// required before treating it as "reasonable frequency".
const HAS_CAR_MIN_FUEL_TRANSACTIONS = 2;
const HAS_CAR_CONFIDENCE = 0.75;

async function inferHasCar(userId: number, now: Date): Promise<void> {
  const fuelTxns = await getExpensesByCategoryName(userId, FUEL_CATEGORY_NAME, daysAgo(now, HAS_CAR_LOOKBACK_DAYS));
  if (fuelTxns.length < HAS_CAR_MIN_FUEL_TRANSACTIONS) return;

  await setInferredFact(
    userId,
    "has_car",
    "true",
    HAS_CAR_CONFIDENCE,
    `${fuelTxns.length} تراکنش بنزین در ${HAS_CAR_LOOKBACK_DAYS} روز اخیر`
  );
}

// ---- is_renter ----
//
// Category names below must match Category.name values actually seeded by
// DEFAULT_CATEGORIES (prisma/seed.ts): مسکن (Housing) > اجاره (Rent).
//
// Same asymmetric-confidence reasoning as has_car: a recurring اجاره
// transaction is strong evidence of renting, but its absence proves
// nothing (owns outright, paying a mortgage that isn't tagged اجاره, rent
// paid by someone else, cash payment never logged, ...). Only "true" is
// ever inferred.
const RENT_CATEGORY_NAME = "اجاره";
const IS_RENTER_LOOKBACK_DAYS = 120;
const IS_RENTER_MIN_TRANSACTIONS = 2;
// "Roughly monthly" tolerance band, in days - wide enough to absorb a rent
// payment landing a few days early/late each cycle without also matching
// unrelated coincidental one-off expenses.
const IS_RENTER_MIN_GAP_DAYS = 25;
const IS_RENTER_MAX_GAP_DAYS = 40;
// Max allowed ratio between the larger and smaller amount of a pair for it
// to still count as "the same fixed amount" (small utilities-included-or-not
// variation is realistic; a materially different amount is not the same rent).
const IS_RENTER_AMOUNT_TOLERANCE_RATIO = 1.2;
const IS_RENTER_CONFIDENCE = 0.7;

/** Whether any two chronologically adjacent transactions look like the same recurring monthly payment (gap + amount both within tolerance). */
function hasRecurringMonthlyPair(sorted: DatedAmount[]): boolean {
  for (let i = 1; i < sorted.length; i++) {
    const gapDays = (sorted[i].date.getTime() - sorted[i - 1].date.getTime()) / MS_PER_DAY;
    if (gapDays < IS_RENTER_MIN_GAP_DAYS || gapDays > IS_RENTER_MAX_GAP_DAYS) continue;

    const lo = Math.min(sorted[i].amount, sorted[i - 1].amount);
    const hi = Math.max(sorted[i].amount, sorted[i - 1].amount);
    if (lo <= 0) continue;
    if (hi / lo <= IS_RENTER_AMOUNT_TOLERANCE_RATIO) return true;
  }
  return false;
}

async function inferIsRenter(userId: number, now: Date): Promise<void> {
  const rentTxns = await getExpensesByCategoryName(userId, RENT_CATEGORY_NAME, daysAgo(now, IS_RENTER_LOOKBACK_DAYS));
  if (rentTxns.length < IS_RENTER_MIN_TRANSACTIONS) return;
  if (!hasRecurringMonthlyPair(rentTxns)) return;

  await setInferredFact(userId, "is_renter", "true", IS_RENTER_CONFIDENCE, "تراکنش اجاره تکرارشونده با فاصله تقریباً ماهانه و مبلغ ثابت");
}

// ---- income_regularity ----
//
// Unlike has_car/is_renter, both "regular" and "irregular" are valid
// inference targets here - there's no single asymmetric direction, since
// this looks at all income-type transactions directly (not one specific
// category) and either consistency or inconsistency is equally direct
// evidence of the corresponding label.
const INCOME_LOOKBACK_DAYS = 180; // 6 months, per spec's 3-6 month window.
// A single transaction has no interval at all, and exactly two have only
// one interval - trivially "consistent" (zero variance) by construction,
// which would misrepresent a coincidence as a pattern. Three is the
// minimum that produces two intervals, the least needed for "consistency"
// to mean anything.
const INCOME_MIN_TRANSACTIONS = 3;
const INCOME_AMOUNT_CV_REGULAR_MAX = 0.15;
const INCOME_INTERVAL_CV_REGULAR_MAX = 0.35;
const INCOME_AMOUNT_CV_IRREGULAR_MIN = 0.6;
const INCOME_INTERVAL_CV_IRREGULAR_MIN = 0.7;
const INCOME_REGULARITY_CONFIDENCE = 0.75;

async function inferIncomeRegularity(userId: number, now: Date): Promise<void> {
  const incomeTxns = await prisma.transaction.findMany({
    where: { userId, type: "income", date: { gte: daysAgo(now, INCOME_LOOKBACK_DAYS) } },
    select: { amount: true, date: true },
    orderBy: { date: "asc" },
  });

  if (incomeTxns.length < INCOME_MIN_TRANSACTIONS) return;

  const amountCv = coefficientOfVariation(incomeTxns.map((t) => t.amount));
  const gapsDays: number[] = [];
  for (let i = 1; i < incomeTxns.length; i++) {
    gapsDays.push((incomeTxns[i].date.getTime() - incomeTxns[i - 1].date.getTime()) / MS_PER_DAY);
  }
  const intervalCv = coefficientOfVariation(gapsDays);

  const note = `${incomeTxns.length} تراکنش درآمد در ${INCOME_LOOKBACK_DAYS} روز اخیر`;

  if (amountCv <= INCOME_AMOUNT_CV_REGULAR_MAX && intervalCv <= INCOME_INTERVAL_CV_REGULAR_MAX) {
    await setInferredFact(userId, "income_regularity", "regular", INCOME_REGULARITY_CONFIDENCE, note);
    return;
  }

  if (amountCv >= INCOME_AMOUNT_CV_IRREGULAR_MIN || intervalCv >= INCOME_INTERVAL_CV_IRREGULAR_MIN) {
    await setInferredFact(userId, "income_regularity", "irregular", INCOME_REGULARITY_CONFIDENCE, note);
    return;
  }

  // Ambiguous middle ground - neither clearly regular nor clearly
  // irregular. Skip rather than force a low-confidence guess either way.
}

/**
 * Runs all rule-based fact inference for a user and writes any confident-
 * enough result via setInferredFact (which itself never overwrites a
 * user_stated fact). Deliberately NOT called from the chat request path -
 * meant to be invoked periodically (e.g. a future cron/admin action), kept
 * as a plain callable function here since no scheduler exists yet. Safe to
 * re-run any time: every check either re-derives the same conclusion
 * (upserting the same value) or finds insufficient signal and skips.
 */
export async function inferFactsForUser(userId: number): Promise<void> {
  const now = new Date();
  await Promise.all([inferHasCar(userId, now), inferIsRenter(userId, now), inferIncomeRegularity(userId, now)]);
}
