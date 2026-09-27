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
import { generateGoalStrategy, INFLATION_HEDGE_HORIZON_MONTHS, type GoalStrategyGoalInput } from "@/lib/goals/strategy";
import type { GoalFeasibility } from "@/lib/goals/feasibility";
import type { SpendingSummary } from "@/lib/analytics/spending-summary";
import { formatToman } from "@/lib/format";

// deadline/monthsRemaining are kept far beyond INFLATION_HEDGE_HORIZON_MONTHS
// by default (24 months) so the base fixtures exercise the "applicable"
// branch unless a test overrides monthsRemaining itself - the inflation-note
// describe block below covers both sides of that threshold explicitly.
const GOAL_INPUT: GoalStrategyGoalInput = {
  name: "خرید ماشین",
  targetAmount: 500_000_000,
  initialAmount: 50_000_000,
  deadline: new Date("2027-01-01"),
  availableBalance: 30_000_000,
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
    availableBalance: 0,
    savingsBalance: 0,
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

  // Regression coverage for the "استراتژی ساخته نشد" production bug: this
  // schema (up to 5 actions plus summary/monthlyAction/inflationNote) is far
  // larger than lib/nvidia-ai.ts's own JSON_EXTRACTION_MAX_TOKENS (1500,
  // sized for a single flat transaction object), so generateGoalStrategy
  // must request its own larger budget via chatCompletion's maxTokens
  // override rather than silently falling back to that shared default -
  // otherwise a full-length response risks being cut off mid-JSON.
  it("requests a larger dedicated token budget than the shared JSON-extraction default", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(
      JSON.stringify({ actions: [validAction(), validAction(), validAction()], summary: "خلاصه" })
    );

    await generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID);

    expect(chatCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ json: true, maxTokens: expect.any(Number) })
    );
    const [, options] = vi.mocked(chatCompletion).mock.calls[0];
    expect(options?.maxTokens).toBeGreaterThan(1500);
  });

  // Regression coverage for the goals/strategy production timeout: this
  // call's larger token budget (above) also means fetch() legitimately takes
  // longer to resolve (chatCompletion is non-streaming - see
  // NVIDIA_REQUEST_TIMEOUT_MS's own comment), so it must request its own
  // longer timeout via chatCompletion's timeoutMs override rather than
  // silently relying on the shared 30s default - otherwise a full-length
  // response risks being aborted mid-generation (AI_ERROR logs with
  // duration: 30002 - lib/nvidia-ai.ts's shared default - were the actual
  // production symptom this covers).
  it("requests a longer dedicated timeout than the shared gateway default", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(
      JSON.stringify({ actions: [validAction(), validAction(), validAction()], summary: "خلاصه" })
    );

    await generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID);

    const [, options] = vi.mocked(chatCompletion).mock.calls[0];
    expect(options?.timeoutMs).toBeGreaterThan(30_000);
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
      "استراتژی ساخته نشد، دوباره تلاش کن."
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
    expect(strategy.summary).toBe("برای رسیدن به این هدف، این اقدام‌ها رو در نظر بگیر.");
  });

  it("throws the Persian user-facing error when the response isn't valid JSON", async () => {
    vi.mocked(chatCompletion).mockResolvedValue("این یک پاسخ نامعتبر است، نه JSON");

    await expect(generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID)).rejects.toThrow(
      "استراتژی ساخته نشد، دوباره تلاش کن."
    );
  });

  it("throws the Persian user-facing error when the response has no actions array", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify({ summary: "خلاصه" }));

    await expect(generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID)).rejects.toThrow(
      "استراتژی ساخته نشد، دوباره تلاش کن."
    );
  });

  it("throws the Persian user-facing error when the AI call itself fails", async () => {
    vi.mocked(chatCompletion).mockRejectedValue(new Error("network down"));

    await expect(generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID)).rejects.toThrow(
      "استراتژی ساخته نشد، دوباره تلاش کن."
    );
  });

  describe("progress", () => {
    it("computes currentAmount/percentage deterministically from initialAmount + availableBalance, ignoring anything the model returns", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          actions: [validAction({ title: "یک" }), validAction({ title: "دو" }), validAction({ title: "سه" })],
        })
      );

      const strategy = await generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID);

      const expectedCurrentAmount = GOAL_INPUT.initialAmount + GOAL_INPUT.availableBalance;
      expect(strategy.progress).toEqual({
        currentAmount: expectedCurrentAmount,
        targetAmount: GOAL_INPUT.targetAmount,
        percentage: Math.round((expectedCurrentAmount / GOAL_INPUT.targetAmount) * 100),
      });
    });

    it("clamps percentage to 100 when current progress meets or exceeds the target", async () => {
      const goal: GoalStrategyGoalInput = { ...GOAL_INPUT, initialAmount: 480_000_000, availableBalance: 50_000_000 };
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          actions: [validAction({ title: "یک" }), validAction({ title: "دو" }), validAction({ title: "سه" })],
        })
      );

      const strategy = await generateGoalStrategy(goal, FEASIBILITY, USER_ID);
      expect(strategy.progress.percentage).toBe(100);
    });
  });

  describe("monthlyAction", () => {
    it("parses title/description from the model's response and always overrides amount with feasibility.requiredMonthlyAmount", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          actions: [validAction({ title: "یک" }), validAction({ title: "دو" }), validAction({ title: "سه" })],
          summary: "خلاصه",
          monthlyActionTitle: "پس‌انداز خودکار ماهانه",
          monthlyActionDescription: "همان روز دریافت حقوق، این مبلغ را به حساب پس‌انداز منتقل کن.",
        })
      );

      const strategy = await generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID);

      expect(strategy.monthlyAction).toEqual({
        title: "پس‌انداز خودکار ماهانه",
        description: "همان روز دریافت حقوق، این مبلغ را به حساب پس‌انداز منتقل کن.",
        amount: FEASIBILITY.requiredMonthlyAmount,
      });
    });

    it("falls back to generic wording (still stating the real amount) when the model omits monthlyActionTitle/Description", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          actions: [validAction({ title: "یک" }), validAction({ title: "دو" }), validAction({ title: "سه" })],
        })
      );

      const strategy = await generateGoalStrategy(GOAL_INPUT, FEASIBILITY, USER_ID);

      expect(strategy.monthlyAction.title).toBeTruthy();
      expect(strategy.monthlyAction.amount).toBe(FEASIBILITY.requiredMonthlyAmount);
      expect(strategy.monthlyAction.description).toContain(formatToman(FEASIBILITY.requiredMonthlyAmount));
    });
  });

  describe("inflationNote", () => {
    it("includes the model's note when the goal's horizon exceeds INFLATION_HEDGE_HORIZON_MONTHS", async () => {
      const feasibility: GoalFeasibility = { ...FEASIBILITY, monthsRemaining: INFLATION_HEDGE_HORIZON_MONTHS + 1 };
      const note = "نگه‌داشتن این مبلغ به‌صورت نقد راکد ممکن است ارزش واقعی آن را در این بازه کاهش دهد.";
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          actions: [validAction({ title: "یک" }), validAction({ title: "دو" }), validAction({ title: "سه" })],
          inflationNote: note,
        })
      );

      const strategy = await generateGoalStrategy(GOAL_INPUT, feasibility, USER_ID);
      expect(strategy.inflationNote).toBe(note);
    });

    it("is null when the horizon is at or below INFLATION_HEDGE_HORIZON_MONTHS, even if the model returns a note", async () => {
      const feasibility: GoalFeasibility = { ...FEASIBILITY, monthsRemaining: INFLATION_HEDGE_HORIZON_MONTHS };
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          actions: [validAction({ title: "یک" }), validAction({ title: "دو" }), validAction({ title: "سه" })],
          inflationNote: "یک نکته‌ای که با مهلت کوتاه نباید نمایش داده شود.",
        })
      );

      const strategy = await generateGoalStrategy(GOAL_INPUT, feasibility, USER_ID);
      expect(strategy.inflationNote).toBeNull();
    });

    it("is null when the horizon exceeds the threshold but the model omits the note", async () => {
      const feasibility: GoalFeasibility = { ...FEASIBILITY, monthsRemaining: INFLATION_HEDGE_HORIZON_MONTHS + 1 };
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          actions: [validAction({ title: "یک" }), validAction({ title: "دو" }), validAction({ title: "سه" })],
        })
      );

      const strategy = await generateGoalStrategy(GOAL_INPUT, feasibility, USER_ID);
      expect(strategy.inflationNote).toBeNull();
    });

    it("drops a note that names a specific instrument despite the prompt's rules (defense-in-depth)", async () => {
      const feasibility: GoalFeasibility = { ...FEASIBILITY, monthsRemaining: INFLATION_HEDGE_HORIZON_MONTHS + 1 };
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          actions: [validAction({ title: "یک" }), validAction({ title: "دو" }), validAction({ title: "سه" })],
          inflationNote: "بخشی از این مبلغ را به طلا یا سکه تبدیل کن.",
        })
      );

      const strategy = await generateGoalStrategy(GOAL_INPUT, feasibility, USER_ID);
      expect(strategy.inflationNote).toBeNull();
    });
  });
});
