import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  getUserFacts,
  setUserStatedFact,
  setInferredFact,
  formatFactsForPrompt,
  UnknownFactKeyError,
  FactNotInferableError,
  type UserFact,
} from "@/lib/facts/user-facts";

// The precedence tests below hit the real dev DB - same latency
// consideration as lib/analytics/spending-summary.test.ts.
vi.setConfig({ testTimeout: 15000 });

async function makeUser(label: string): Promise<number> {
  const user = await prisma.user.create({ data: { phoneNumber: `TEST-USER-FACTS-${label}-${Date.now()}` } });
  return user.id;
}

async function cleanup(userId: number): Promise<void> {
  await prisma.userFact.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

describe("setUserStatedFact / setInferredFact precedence", () => {
  let overrideUserId: number;
  let protectedUserId: number;

  beforeAll(async () => {
    [overrideUserId, protectedUserId] = await Promise.all([makeUser("OVERRIDE"), makeUser("PROTECTED")]);
  }, 20000);

  afterAll(async () => {
    await Promise.all([cleanup(overrideUserId), cleanup(protectedUserId)]);
    await prisma.$disconnect();
  }, 20000);

  it("setUserStatedFact overwrites an existing inferred fact for the same key", async () => {
    await setInferredFact(overrideUserId, "has_car", "false", 0.7, "بدون تراکنش بنزین");
    const stated = await setUserStatedFact(overrideUserId, "has_car", "true");

    expect(stated.source).toBe("user_stated");
    expect(stated.value).toBe("true");
    expect(stated.confidence).toBeNull();

    const facts = await getUserFacts(overrideUserId);
    expect(facts).toHaveLength(1);
    expect(facts[0].source).toBe("user_stated");
    expect(facts[0].value).toBe("true");
  });

  it("setInferredFact never overwrites an existing user_stated fact for the same key", async () => {
    await setUserStatedFact(protectedUserId, "is_renter", "true", "کاربر گفت مستأجر است");
    const result = await setInferredFact(protectedUserId, "is_renter", "false", 0.8, "بدون تراکنش اجاره");

    expect(result).toBeNull();

    const facts = await getUserFacts(protectedUserId);
    expect(facts).toHaveLength(1);
    expect(facts[0].source).toBe("user_stated");
    expect(facts[0].value).toBe("true");
  });
});

describe("known-key validation", () => {
  // Validation happens before any DB access in both setters, so these don't
  // need a real user row - the call throws synchronously-in-effect before
  // ever reaching Prisma.
  it("setUserStatedFact rejects an unknown key", async () => {
    await expect(setUserStatedFact(-1, "not_a_real_key", "true")).rejects.toThrow(UnknownFactKeyError);
  });

  it("setInferredFact rejects an unknown key", async () => {
    await expect(setInferredFact(-1, "not_a_real_key", "true", 0.8)).rejects.toThrow(UnknownFactKeyError);
  });

  it("setInferredFact rejects a key that's registered as user_stated-only", async () => {
    await expect(setInferredFact(-1, "has_dependents", "true", 0.8)).rejects.toThrow(FactNotInferableError);
  });
});

describe("formatFactsForPrompt", () => {
  const baseFact: UserFact = {
    id: 1,
    userId: 1,
    key: "has_car",
    value: "true",
    source: "user_stated",
    confidence: null,
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("includes a user_stated fact (always certain, no confidence threshold applies)", () => {
    const text = formatFactsForPrompt([baseFact]);
    expect(text).toContain("ماشین دارد");
  });

  it("includes an inferred fact at or above the confidence threshold", () => {
    const fact: UserFact = { ...baseFact, key: "is_renter", source: "inferred", confidence: 0.6 };
    expect(formatFactsForPrompt([fact])).toContain("مستأجر است");
  });

  it("excludes an inferred fact below the confidence threshold", () => {
    const fact: UserFact = { ...baseFact, key: "is_renter", source: "inferred", confidence: 0.4 };
    const text = formatFactsForPrompt([fact]);
    expect(text).not.toContain("مستأجر است");
    expect(text).toBe("اطلاعاتی ثبت نشده");
  });

  it("returns the fallback message for an empty list", () => {
    expect(formatFactsForPrompt([])).toBe("اطلاعاتی ثبت نشده");
  });
});
