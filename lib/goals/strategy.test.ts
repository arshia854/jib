import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/nvidia-ai", () => ({
  chatCompletion: vi.fn(),
  AI_PROVIDER: "nvidia-nim",
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

// generateGoalStrategy calls getSpendingSummary (a real Prisma read) purely
// for its own grounding data (topDiscretionaryCategories/recurringExpenses)
// - mocked here the same way chatCompletion is, so this file stays a pure
// unit test with no DB fixture needed, matching lib/ai/parse-transaction.test.ts's
// own "mock the one thing that reaches out" convention.
vi.mock("@/lib/analytics/spending-summary", () => ({
  getSpendingSummary: vi.fn(),
}));

import { chatCompletion } from "@/lib/nvidia-ai";
import { getSpendingSummary } from "@/lib/analytics/spending-summary";
import { generateGoalStrategy, type GoalStrategyGoalInput } from "@/lib/goals/strategy";
import type { GoalFeasibility } from "@/lib/goals/feasibility";
import type { SpendingSummary } from "@/lib/analytics/spending-summary";

const GOAL_INPUT: GoalStrategyGoalInput = {
  name: "خرید ماشین",
  targetAmount: 500_000_000,
  initialAmount: 50_000_000,
  deadline: new Date("2027-01-01"),
};

const FEASIBILITY: GoalFeasibility = {
  requiredMonthlyAmount: 20_000_000,
  actualMonthlyAverage: 10_000_000,
  feasibilityRatio: 0.5,
  feasibilityStatus: "unrealistic",
  projectedCompletionMonths: 45,
  gap: 10_000_000,
  monthsRemaining: 24,
};

const USER_ID = 1;

// Only the two fields generateGoalStrategy's grounding data actually reads
// (topDiscretionaryCategories/recurringExpenses) are populated with real
// values - the rest of SpendingSummary is irrelevant to this module, so
// zeroed/emptied and cast, same "mock only what the function under test
// reads" spirit as parse-transaction.test.ts's own category fixtures.
function spendingSummaryFixture(): SpendingSummary {
  return {
    totalBalance: 0,
    currentMonth: { label: "", income: 0, expense: 0, categories: [], discretionaryExpense: 0 },
    previousMonth: { label: "", income: 0, expense: 0, categories: [], discretionaryExpense: 0 },
    categoryTrends: [],
    topMerchants: [],
    topDiscretionaryCategories: [{ name: "خوراک و رستوران", total: 3_000_000 }],
    recentTransactions: [],
    unusualTransactions: [],
    recurringExpenses: [{ description: "نتفلیکس", monthsPresent: 3, monthsChecked: 3, averageAmount: 200_000 }],
    cashFlowTrend: [],
  };
}

function validAction(overrides: Record<string, unknown> = {}) {
  return {
    type: "reduce_expense",
    title: "کاهش هزینه رستوران",
    description: "خرید رستوران را کاهش دهید.",
    relatedAmount: 3_000_000,
    ...overrides,
  };
}

describe("generateGoalStrategy", () => {
  beforeEach(() => {
    vi.mocked(chatCompletion).mockReset();
    vi.mocked(getSpendingSummary).mockReset();
    vi.mocked(getSpendingSummary).mockResolvedValue(spendingSummaryFixture());
  });

  it("accepts a fully valid response and assigns sequential priority", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(
      JSON.stringify({
        actions: [
          validAction({ title: "اول", priority: 9 }),
          validAction({ title: "دوم", type: "increase_savings", relatedAmount: undefined }),
          validAction({ title: "سوم", type: "extra_income", relatedAmount: null }),
        ],
        summary: "خلاصه استراتژی",
      })
    );

    const strategy = await generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID);

    expect(strategy.summary).toBe("خلاصه استراتژی");
    expect(strategy.actions).toHaveLength(3);
    expect(strategy.actions.map((a) => a.priority)).toEqual([1, 2, 3]);
    expect(strategy.actions[0]).toMatchObject({ title: "اول", type: "reduce_expense", relatedAmount: 3_000_000 });
    expect(strategy.actions[1].relatedAmount).toBeUndefined();
    expect(typeof strategy.generatedAt).toBe("string");
  });

  it("caps at 5 actions when the model returns more", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(
      JSON.stringify({
        actions: Array.from({ length: 7 }, (_, i) => validAction({ title: `اقدام ${i}` })),
        summary: "خلاصه",
      })
    );

    const strategy = await generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID);
    expect(strategy.actions).toHaveLength(5);
    expect(strategy.actions.map((a) => a.priority)).toEqual([1, 2, 3, 4, 5]);
  });

  it("drops one malformed action but still accepts the response when >= 3 remain valid", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(
      JSON.stringify({
        actions: [
          validAction({ title: "معتبر یک" }),
          validAction({ title: "معتبر دو", type: "increase_savings" }),
          { type: "not_a_real_type", title: "نامعتبر", description: "توضیح" },
          validAction({ title: "معتبر سه", type: "extra_income" }),
        ],
        summary: "خلاصه",
      })
    );

    const strategy = await generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID);
    expect(strategy.actions).toHaveLength(3);
    expect(strategy.actions.map((a) => a.title)).toEqual(["معتبر یک", "معتبر دو", "معتبر سه"]);
  });

  it("throws the Persian user-facing error when fewer than 3 actions survive validation", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(
      JSON.stringify({
        actions: [
          validAction({ title: "معتبر یک" }),
          { type: "not_a_real_type", title: "نامعتبر یک", description: "توضیح" },
          { type: "reduce_expense", title: "", description: "بدون عنوان" },
        ],
        summary: "خلاصه",
      })
    );

    await expect(generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID)).rejects.toThrow(
      "در تولید استراتژی خطایی رخ داد. دوباره تلاش کنید."
    );
  });

  it("drops only the invalid relatedAmount, keeping the rest of that action", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(
      JSON.stringify({
        actions: [
          validAction({ title: "یک", relatedAmount: -5 }),
          validAction({ title: "دو", type: "increase_savings" }),
          validAction({ title: "سه", type: "extra_income" }),
        ],
        summary: "خلاصه",
      })
    );

    const strategy = await generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID);
    expect(strategy.actions).toHaveLength(3);
    const first = strategy.actions.find((a) => a.title === "یک");
    expect(first).toBeDefined();
    expect(first?.relatedAmount).toBeUndefined();
  });

  it("falls back to a default summary when the model omits it", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(
      JSON.stringify({
        actions: [validAction({ title: "یک" }), validAction({ title: "دو" }), validAction({ title: "سه" })],
      })
    );

    const strategy = await generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID);
    expect(strategy.summary).toBe("برای رسیدن به این هدف، اقدام‌های زیر را در نظر بگیرید.");
  });

  it("throws the Persian user-facing error when the response isn't valid JSON", async () => {
    vi.mocked(chatCompletion).mockResolvedValue("این یک پاسخ نامعتبر است، نه JSON");

    await expect(generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID)).rejects.toThrow(
      "در تولید استراتژی خطایی رخ داد. دوباره تلاش کنید."
    );
  });

  it("throws the Persian user-facing error when the response has no actions array", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify({ summary: "خلاصه" }));

    await expect(generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID)).rejects.toThrow(
      "در تولید استراتژی خطایی رخ داد. دوباره تلاش کنید."
    );
  });

  it("throws the Persian user-facing error when the AI call itself fails", async () => {
    vi.mocked(chatCompletion).mockRejectedValue(new Error("network down"));

    await expect(generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID)).rejects.toThrow(
      "در تولید استراتژی خطایی رخ داد. دوباره تلاش کنید."
    );
  });
});
