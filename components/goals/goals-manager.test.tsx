// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { GoalsManager } from "@/components/goals/goals-manager";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const goal = {
  id: 1,
  name: "مک‌بوک",
  category: "other",
  targetAmount: 60_000_000,
  initialAmount: 0,
  deadline: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  status: "active",
  feasibility: {
    requiredMonthlyAmount: 16_465_568,
    actualMonthlyAverage: 20_000_000,
    feasibilityStatus: "on_track" as const,
    projectedCompletionMonths: 1,
    gap: 0,
  },
};

function strategy(currentAmount: number) {
  return {
    actions: [
      { type: "reduce_expense", title: "خرید لوازم خانه را محدود کن", description: "توضیح ۱", relatedAmount: 400_000_000, priority: 1 },
      { type: "increase_savings", title: "سهم هدف را اول ماه کنار بگذار", description: "توضیح ۲", priority: 2 },
      { type: "extra_income", title: "یک درآمد اضافه", description: "توضیح ۳", priority: 3 },
    ],
    summary: "خلاصه‌ی استراتژی",
    progress: { currentAmount, targetAmount: 60_000_000, percentage: currentAmount > 0 ? 25 : 0 },
    monthlyAction: { title: "انتقال خودکار ماهانه", description: "اول هر ماه منتقل کن.", amount: 16_465_568 },
    inflationNote: null,
    generatedAt: new Date().toISOString(),
  };
}

function stubStrategyFetch(body: unknown, status = 200) {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify(body), { status });
    })
  );
  return resolve;
}

describe("GoalsManager - goal strategy", () => {
  it("shows a loading panel while generating, then the strategy with regenerate moved into its header", async () => {
    const release = stubStrategyFetch({ strategy: strategy(15_000_000) });
    render(<GoalsManager goals={[goal]} />);

    fireEvent.click(screen.getByRole("button", { name: /دریافت استراتژی/ }));
    expect(screen.getByRole("status").textContent).toContain("ممکنه تا یک دقیقه طول بکشه");

    release();
    expect(await screen.findByText("استراتژی پیشنهادی")).toBeDefined();
    expect(screen.getByRole("button", { name: /ساخت دوباره/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /دریافت استراتژی/ })).toBeNull();
    expect(screen.getByText("۱۶٬۴۶۵٬۵۶۸")).toBeDefined();
  });

  it("describes a negative goal share instead of calling a negative amount 'collected'", async () => {
    stubStrategyFetch({ strategy: strategy(-22_337_841) })();
    render(<GoalsManager goals={[goal]} />);
    fireEvent.click(screen.getByRole("button", { name: /دریافت استراتژی/ }));

    expect(await screen.findByText("۲۲٫۳ میلیون تومان")).toBeDefined();
    expect(screen.getByText(/منفیه/)).toBeDefined();
    expect(screen.queryByText(/جمع شده/)).toBeNull();
  });

  it("labels each action's kind and its related amount", async () => {
    stubStrategyFetch({ strategy: strategy(15_000_000) })();
    render(<GoalsManager goals={[goal]} />);
    fireEvent.click(screen.getByRole("button", { name: /دریافت استراتژی/ }));

    expect(await screen.findByText("کاهش هزینه")).toBeDefined();
    expect(screen.getByText("پس‌انداز بیشتر")).toBeDefined();
    expect(screen.getByText("درآمد اضافه")).toBeDefined();
    expect(screen.getByText("۴۰۰ میلیون تومان")).toBeDefined();
    expect(screen.getByText(/خرج فعلی/)).toBeDefined();
  });

  it("shows the error with a retry button when generation fails", async () => {
    stubStrategyFetch({ error: "استراتژی ساخته نشد، دوباره تلاش کن." }, 500)();
    render(<GoalsManager goals={[goal]} />);
    fireEvent.click(screen.getByRole("button", { name: /دریافت استراتژی/ }));

    expect(await screen.findByText("استراتژی ساخته نشد، دوباره تلاش کن.")).toBeDefined();
    expect(screen.getByRole("button", { name: /تلاش دوباره/ })).toBeDefined();
  });
});
