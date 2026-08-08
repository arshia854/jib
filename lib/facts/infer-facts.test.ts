import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { inferFactsForUser } from "@/lib/facts/infer-facts";
import { getUserFacts } from "@/lib/facts/user-facts";

// Each test writes fixture transactions and then runs the full inference
// pass against the real (network-latency-bound) dev DB - same timeout
// widening as lib/analytics/spending-summary.test.ts.
vi.setConfig({ testTimeout: 15000 });

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * MS_PER_DAY);
}

async function makeUserWithAccount(label: string) {
  const user = await prisma.user.create({ data: { phoneNumber: `TEST-INFER-FACTS-${label}-${Date.now()}` } });
  const account = await prisma.financeAccount.create({
    data: { userId: user.id, name: "حساب تست", type: "cash", initialBalance: 0 },
  });
  return { userId: user.id, accountId: account.id };
}

async function makeCategory(userId: number, name: string, type: "income" | "expense") {
  const category = await prisma.category.create({ data: { userId, name, icon: "🧪", color: "#000000", type } });
  return category.id;
}

function makeTransaction(
  userId: number,
  accountId: number,
  categoryId: number,
  type: "income" | "expense",
  amount: number,
  date: Date
) {
  return prisma.transaction.create({ data: { userId, accountId, categoryId, amount, type, rawInput: "تست", date } });
}

async function cleanup(userId: number) {
  await prisma.userFact.deleteMany({ where: { userId } });
  await prisma.transaction.deleteMany({ where: { userId } });
  await prisma.category.deleteMany({ where: { userId } });
  await prisma.financeAccount.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

describe("inferFactsForUser", () => {
  let carSignalUserId: number;
  let noCarSignalUserId: number;
  let fewIncomeUserId: number;
  let regularIncomeUserId: number;
  let irregularIncomeUserId: number;
  let renterUserId: number;

  beforeAll(async () => {
    async function setupCarSignal() {
      const { userId, accountId } = await makeUserWithAccount("CAR-SIGNAL");
      const fuelCategoryId = await makeCategory(userId, "بنزین", "expense");
      await Promise.all([
        makeTransaction(userId, accountId, fuelCategoryId, "expense", 300000, daysAgo(10)),
        makeTransaction(userId, accountId, fuelCategoryId, "expense", 320000, daysAgo(40)),
        makeTransaction(userId, accountId, fuelCategoryId, "expense", 310000, daysAgo(70)),
      ]);
      return userId;
    }

    async function setupNoCarSignal() {
      const { userId, accountId } = await makeUserWithAccount("NO-CAR-SIGNAL");
      const fuelCategoryId = await makeCategory(userId, "بنزین", "expense");
      // Only a single fuel purchase - below the "reasonable frequency"
      // minimum, so this must produce no has_car fact at all (not even a
      // low-confidence "true").
      await makeTransaction(userId, accountId, fuelCategoryId, "expense", 300000, daysAgo(10));
      return userId;
    }

    async function setupFewIncome() {
      const { userId, accountId } = await makeUserWithAccount("FEW-INCOME");
      const salaryCategoryId = await makeCategory(userId, "حقوق", "income");
      // Only 2 income transactions - below the minimum needed to say
      // anything about interval consistency (see infer-facts.ts comment).
      await Promise.all([
        makeTransaction(userId, accountId, salaryCategoryId, "income", 5000000, daysAgo(5)),
        makeTransaction(userId, accountId, salaryCategoryId, "income", 5000000, daysAgo(35)),
      ]);
      return userId;
    }

    async function setupRegularIncome() {
      const { userId, accountId } = await makeUserWithAccount("REGULAR-INCOME");
      const salaryCategoryId = await makeCategory(userId, "حقوق", "income");
      // Same amount (±small variance) every ~30 days.
      await Promise.all([
        makeTransaction(userId, accountId, salaryCategoryId, "income", 5000000, daysAgo(5)),
        makeTransaction(userId, accountId, salaryCategoryId, "income", 5020000, daysAgo(35)),
        makeTransaction(userId, accountId, salaryCategoryId, "income", 4980000, daysAgo(65)),
        makeTransaction(userId, accountId, salaryCategoryId, "income", 5010000, daysAgo(95)),
      ]);
      return userId;
    }

    async function setupIrregularIncome() {
      const { userId, accountId } = await makeUserWithAccount("IRREGULAR-INCOME");
      const freelanceCategoryId = await makeCategory(userId, "درآمد آزاد", "income");
      // Wildly different amounts at irregular intervals.
      await Promise.all([
        makeTransaction(userId, accountId, freelanceCategoryId, "income", 1500000, daysAgo(3)),
        makeTransaction(userId, accountId, freelanceCategoryId, "income", 9000000, daysAgo(20)),
        makeTransaction(userId, accountId, freelanceCategoryId, "income", 2000000, daysAgo(100)),
        makeTransaction(userId, accountId, freelanceCategoryId, "income", 8000000, daysAgo(150)),
      ]);
      return userId;
    }

    async function setupRenter() {
      const { userId, accountId } = await makeUserWithAccount("RENTER");
      const rentCategoryId = await makeCategory(userId, "اجاره", "expense");
      // Same amount, ~30 days apart.
      await Promise.all([
        makeTransaction(userId, accountId, rentCategoryId, "expense", 20000000, daysAgo(2)),
        makeTransaction(userId, accountId, rentCategoryId, "expense", 20000000, daysAgo(32)),
      ]);
      return userId;
    }

    [carSignalUserId, noCarSignalUserId, fewIncomeUserId, regularIncomeUserId, irregularIncomeUserId, renterUserId] =
      await Promise.all([
        setupCarSignal(),
        setupNoCarSignal(),
        setupFewIncome(),
        setupRegularIncome(),
        setupIrregularIncome(),
        setupRenter(),
      ]);
  }, 30000);

  afterAll(async () => {
    await Promise.all(
      [carSignalUserId, noCarSignalUserId, fewIncomeUserId, regularIncomeUserId, irregularIncomeUserId, renterUserId].map(
        cleanup
      )
    );
    await prisma.$disconnect();
  }, 30000);

  it("infers has_car=true from repeated fuel-category transactions", async () => {
    await inferFactsForUser(carSignalUserId);
    const facts = await getUserFacts(carSignalUserId);
    const hasCar = facts.find((f) => f.key === "has_car");
    expect(hasCar?.value).toBe("true");
    expect(hasCar?.source).toBe("inferred");
  });

  it("does not write has_car from a single fuel transaction (insufficient signal)", async () => {
    await inferFactsForUser(noCarSignalUserId);
    const facts = await getUserFacts(noCarSignalUserId);
    expect(facts.find((f) => f.key === "has_car")).toBeUndefined();
  });

  it("does not classify income_regularity below the minimum transaction count", async () => {
    await inferFactsForUser(fewIncomeUserId);
    const facts = await getUserFacts(fewIncomeUserId);
    expect(facts.find((f) => f.key === "income_regularity")).toBeUndefined();
  });

  it("infers income_regularity=regular from consistent amounts and monthly intervals", async () => {
    await inferFactsForUser(regularIncomeUserId);
    const facts = await getUserFacts(regularIncomeUserId);
    expect(facts.find((f) => f.key === "income_regularity")?.value).toBe("regular");
  });

  it("infers income_regularity=irregular from inconsistent amounts and intervals", async () => {
    await inferFactsForUser(irregularIncomeUserId);
    const facts = await getUserFacts(irregularIncomeUserId);
    expect(facts.find((f) => f.key === "income_regularity")?.value).toBe("irregular");
  });

  it("infers is_renter=true from a recurring roughly-monthly fixed-amount rent transaction", async () => {
    await inferFactsForUser(renterUserId);
    const facts = await getUserFacts(renterUserId);
    expect(facts.find((f) => f.key === "is_renter")?.value).toBe("true");
  });
});
