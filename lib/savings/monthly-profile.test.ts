import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import { getMonthlyFinancialProfile } from "@/lib/savings/monthly-profile";

// Same fixture/cleanup convention as lib/goals/feasibility.test.ts's own
// getActualMonthlyAverage describe block - real users/accounts/categories/
// transactions against the actual (test-DB-pointed, see vitest.config.ts)
// prisma client rather than a mock.
const currentRange = getJalaaliMonthRange();
// The most recent of the 3 trailing *closed* months the default lookback
// covers (the cursor loop walks "immediately-prior first").
const range1 = getJalaaliMonthRange(new Date(currentRange.start.getTime() - 1));
const range2 = getJalaaliMonthRange(new Date(range1.start.getTime() - 1));
const range3 = getJalaaliMonthRange(new Date(range2.start.getTime() - 1));

function dateInMonth(range: { start: Date }, dayOffset: number): Date {
  return new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() + dayOffset);
}

async function makeUserWithAccount(label: string) {
  const user = await prisma.user.create({
    data: { phoneNumber: `TEST-SAVINGS-PROFILE-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  const account = await prisma.financeAccount.create({
    data: { userId: user.id, name: "حساب تست", type: "cash", initialBalance: 0 },
  });
  return { userId: user.id, accountId: account.id };
}

async function cleanup(userId: number) {
  await prisma.transaction.deleteMany({ where: { userId } });
  await prisma.category.deleteMany({ where: { userId } });
  await prisma.financeAccount.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

describe("getMonthlyFinancialProfile", () => {
  let emptyUserId: number;
  let mixedUserId: number;
  let mixedAccountId: number;
  let singleActiveMonthUserId: number;
  let singleActiveMonthAccountId: number;

  beforeAll(async () => {
    ({ userId: emptyUserId } = await makeUserWithAccount("EMPTY"));

    // Mixed 3-month history: income, essential expense, and discretionary
    // expense in each of the 3 trailing closed months, at different amounts
    // per month so the average is a real average, not a repeated constant.
    const mixed = await makeUserWithAccount("MIXED");
    mixedUserId = mixed.userId;
    mixedAccountId = mixed.accountId;
    const [incomeCategory, essentialCategory, discretionaryCategory] = await Promise.all([
      prisma.category.create({
        data: { userId: mixedUserId, name: "حقوق تست پروفایل", icon: "💰", color: "#300001", type: "income" },
      }),
      prisma.category.create({
        data: {
          userId: mixedUserId,
          name: "اجاره تست پروفایل",
          icon: "🏠",
          color: "#300002",
          type: "expense",
          isEssential: true,
        },
      }),
      prisma.category.create({
        data: {
          userId: mixedUserId,
          name: "سرگرمی تست پروفایل",
          icon: "🎮",
          color: "#300003",
          type: "expense",
          isEssential: false,
        },
      }),
    ]);

    // range1: income 5,000,000 / essential 2,000,000 / discretionary 1,000,000 -> net 2,000,000
    // range2: income 6,000,000 / essential 2,500,000 / discretionary 500,000  -> net 3,000,000
    // range3: income 4,000,000 / essential 1,500,000 / discretionary 1,500,000 -> net 1,000,000
    // avgIncome = 5,000,000, avgEssentialExpense = 2,000,000,
    // avgDiscretionaryExpense = 1,000,000, avgNetCashFlow = 2,000,000.
    const monthPlans = [
      { range: range1, income: 5_000_000, essential: 2_000_000, discretionary: 1_000_000 },
      { range: range2, income: 6_000_000, essential: 2_500_000, discretionary: 500_000 },
      { range: range3, income: 4_000_000, essential: 1_500_000, discretionary: 1_500_000 },
    ];

    await Promise.all(
      monthPlans.flatMap((plan) => [
        prisma.transaction.create({
          data: {
            userId: mixedUserId,
            accountId: mixedAccountId,
            categoryId: incomeCategory.id,
            amount: plan.income,
            type: "income",
            rawInput: "تست",
            date: dateInMonth(plan.range, 2),
          },
        }),
        prisma.transaction.create({
          data: {
            userId: mixedUserId,
            accountId: mixedAccountId,
            categoryId: essentialCategory.id,
            amount: plan.essential,
            type: "expense",
            rawInput: "تست",
            date: dateInMonth(plan.range, 4),
          },
        }),
        prisma.transaction.create({
          data: {
            userId: mixedUserId,
            accountId: mixedAccountId,
            categoryId: discretionaryCategory.id,
            amount: plan.discretionary,
            type: "expense",
            rawInput: "تست",
            date: dateInMonth(plan.range, 6),
          },
        }),
      ])
    );

    // Only range1 gets data - range2/range3 are left entirely empty,
    // mirroring feasibility.test.ts's own "single active month" fixture, to
    // verify an empty month is excluded from the average rather than
    // counted as a real zero.
    const single = await makeUserWithAccount("SINGLE-ACTIVE-MONTH");
    singleActiveMonthUserId = single.userId;
    singleActiveMonthAccountId = single.accountId;
    const [singleIncome, singleEssential] = await Promise.all([
      prisma.category.create({
        data: { userId: singleActiveMonthUserId, name: "حقوق تک ماه", icon: "💰", color: "#300004", type: "income" },
      }),
      prisma.category.create({
        data: {
          userId: singleActiveMonthUserId,
          name: "خرج تک ماه",
          icon: "🧾",
          color: "#300005",
          type: "expense",
          isEssential: true,
        },
      }),
    ]);
    await Promise.all([
      prisma.transaction.create({
        data: {
          userId: singleActiveMonthUserId,
          accountId: singleActiveMonthAccountId,
          categoryId: singleIncome.id,
          amount: 3_000_000,
          type: "income",
          rawInput: "تست",
          date: dateInMonth(range1, 3),
        },
      }),
      prisma.transaction.create({
        data: {
          userId: singleActiveMonthUserId,
          accountId: singleActiveMonthAccountId,
          categoryId: singleEssential.id,
          amount: 1_000_000,
          type: "expense",
          rawInput: "تست",
          date: dateInMonth(range1, 5),
        },
      }),
    ]);
  });

  afterAll(async () => {
    await cleanup(emptyUserId);
    await cleanup(mixedUserId);
    await cleanup(singleActiveMonthUserId);
  });

  it("returns an all-null profile for a brand-new user with zero transactions", async () => {
    const profile = await getMonthlyFinancialProfile(emptyUserId);
    expect(profile).toEqual({
      avgIncome: null,
      avgEssentialExpense: null,
      avgDiscretionaryExpense: null,
      avgNetCashFlow: null,
    });
  });

  it("computes correct averages across 3 months of mixed income/essential/discretionary transactions", async () => {
    const profile = await getMonthlyFinancialProfile(mixedUserId);
    expect(profile.avgIncome).toBe(5_000_000);
    expect(profile.avgEssentialExpense).toBe(2_000_000);
    expect(profile.avgDiscretionaryExpense).toBe(1_000_000);
    expect(profile.avgNetCashFlow).toBe(2_000_000);
  });

  it("excludes a month with zero transactions from the average rather than counting it as zero", async () => {
    // net = 3,000,000 - 1,000,000 = 2,000,000, from range1 alone. If the two
    // empty months were counted as a real net of 0, the average would be
    // ~666,667 instead - a ~3x understatement purely from lack of history.
    const profile = await getMonthlyFinancialProfile(singleActiveMonthUserId);
    expect(profile.avgIncome).toBe(3_000_000);
    expect(profile.avgEssentialExpense).toBe(1_000_000);
    expect(profile.avgDiscretionaryExpense).toBe(0);
    expect(profile.avgNetCashFlow).toBe(2_000_000);
  });
});
