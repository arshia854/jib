import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import { getFinancialContextSummary } from "@/lib/data/chat-context";

// getFinancialContextSummary fans out to getSpendingSummary (several
// queries) plus getUserFacts, against the same DB spending-summary.test.ts
// uses - same timeout-widening rationale as that file.
vi.setConfig({ testTimeout: 15000 });

const currentRange = getJalaaliMonthRange();
const previousRange = getJalaaliMonthRange(new Date(currentRange.start.getTime() - 1));

function dateInMonth(range: { start: Date }, dayOffset: number): Date {
  return new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() + dayOffset);
}

async function makeUserWithAccount(label: string) {
  const user = await prisma.user.create({
    data: { phoneNumber: `TEST-CHAT-CONTEXT-${label}-${Date.now()}` },
  });
  const account = await prisma.financeAccount.create({
    data: { userId: user.id, name: "حساب تست", type: "cash" },
  });
  return { userId: user.id, accountId: account.id };
}

async function cleanup(userId: number) {
  await prisma.transaction.deleteMany({ where: { userId } });
  await prisma.spendingSummaryCache.deleteMany({ where: { userId } });
  await prisma.category.deleteMany({ where: { userId } });
  await prisma.financeAccount.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

// Phase 10 - getFinancialContextSummary's own text formatting on top of
// getSpendingSummary's new fields (incomeChange/expenseChange/savingsRate/
// unusualTransactions/recurringExpenses). Focused, not exhaustive - the
// underlying data/math is already covered by spending-summary.test.ts;
// this just confirms the new prompt lines are actually present and use
// the "no baseline" omission wording rather than crashing or silently
// dropping the line.
describe("getFinancialContextSummary - Phase 10 additions", () => {
  let noBaselineUserId: number;
  let withTrendUserId: number;

  beforeAll(async () => {
    const noBaseline = await makeUserWithAccount("NO-BASELINE");
    noBaselineUserId = noBaseline.userId;
    const salaryNoBaseline = await prisma.category.create({
      data: { userId: noBaselineUserId, name: "حقوق تست کانتکست ۱", icon: "💰", color: "#200001", type: "income" },
    });
    await prisma.transaction.create({
      data: {
        userId: noBaselineUserId,
        accountId: noBaseline.accountId,
        categoryId: salaryNoBaseline.id,
        amount: 1000000,
        type: "income",
        rawInput: "تست",
        date: dateInMonth(currentRange, 1),
      },
    });

    const withTrend = await makeUserWithAccount("WITH-TREND");
    withTrendUserId = withTrend.userId;
    const salaryWithTrend = await prisma.category.create({
      data: { userId: withTrendUserId, name: "حقوق تست کانتکست ۲", icon: "💰", color: "#200002", type: "income" },
    });
    await Promise.all([
      prisma.transaction.create({
        data: {
          userId: withTrendUserId,
          accountId: withTrend.accountId,
          categoryId: salaryWithTrend.id,
          amount: 1200000,
          type: "income",
          rawInput: "تست",
          date: dateInMonth(currentRange, 1),
        },
      }),
      prisma.transaction.create({
        data: {
          userId: withTrendUserId,
          accountId: withTrend.accountId,
          categoryId: salaryWithTrend.id,
          amount: 1000000,
          type: "income",
          rawInput: "تست",
          date: dateInMonth(previousRange, 1),
        },
      }),
    ]);
  });

  afterAll(async () => {
    await cleanup(noBaselineUserId);
    await cleanup(withTrendUserId);
  });

  it("shows the omission notes for incomeChange/expenseChange/savingsRate when there's no previous-month baseline, but a real savingsRate for the current month", async () => {
    const context = await getFinancialContextSummary(noBaselineUserId);

    expect(context).toContain("- درآمد کل: داده‌ای برای مقایسه نیست");
    expect(context).toContain("- هزینه کل: داده‌ای برای مقایسه نیست");
    // Real income (1,000,000) and zero expense this month -> a computable
    // savings rate, not the "no data" line.
    expect(context).toContain("نرخ پس‌انداز این ماه:");
    expect(context).not.toContain("نرخ پس‌انداز: داده‌ای برای محاسبه نیست");
  });

  it("shows a real percent line for incomeChange when a previous-month baseline exists", async () => {
    const context = await getFinancialContextSummary(withTrendUserId);

    // (1,200,000 - 1,000,000) / 1,000,000 = +20%
    expect(context).toContain("- درآمد کل: +۲۰٪");
  });

  it("includes the recurring-expenses and unusual-transactions sections (empty-state wording when there's nothing to flag)", async () => {
    const context = await getFinancialContextSummary(noBaselineUserId);

    expect(context).toContain("هزینه‌های تکرارشونده (چند ماه اخیر):");
    expect(context).toContain("هزینه تکرارشونده‌ای شناسایی نشد");
    expect(context).toContain("تراکنش‌های غیرعادی این ماه");
    expect(context).toContain("تراکنش غیرعادی‌ای شناسایی نشد");
  });
});
