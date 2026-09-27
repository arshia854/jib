import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  listSavingsStrategies,
  createSavingsStrategy,
  updateSavingsStrategy,
  deleteSavingsStrategy,
  SavingsStrategyNotFoundError,
  DuplicateActiveStrategyError,
} from "@/lib/data/savings-strategies";

describe("listSavingsStrategies", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-SAVINGS-STRATEGIES-DATA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;

    // Deliberately created out of both target orders (createdAt ascending,
    // status interleaved) so the assertions below actually exercise the
    // sort rather than happening to match creation order.
    await prisma.savingsStrategy.create({
      data: { userId, formulaType: "leftover", status: "abandoned", targetPercent: 10 },
    });
    await prisma.savingsStrategy.create({
      data: { userId, formulaType: "roundup", status: "active", targetAmount: 50_000 },
    });
    await prisma.savingsStrategy.create({
      data: { userId, formulaType: "fifty_thirty_twenty", status: "active", targetPercent: 20 },
    });
  });

  afterAll(async () => {
    await prisma.savingsStrategy.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("sorts active strategies first, then by createdAt descending", async () => {
    const strategies = await listSavingsStrategies(userId);
    expect(strategies.map((s) => s.formulaType)).toEqual(["fifty_thirty_twenty", "roundup", "leftover"]);
  });
});

describe("createSavingsStrategy / getSavingsStrategy", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-SAVINGS-STRATEGIES-CREATE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.savingsStrategy.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("creates a strategy with targetPercent set, defaulting status to active", async () => {
    const strategy = await createSavingsStrategy(userId, { formulaType: "fifty_thirty_twenty", targetPercent: 20 });
    expect(strategy.formulaType).toBe("fifty_thirty_twenty");
    expect(strategy.targetPercent).toBe(20);
    expect(strategy.targetAmount).toBeNull();
    expect(strategy.status).toBe("active");
  });
});

describe("duplicate active strategy prevention", () => {
  let userId: number;
  let otherUserId: number;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    userId = (await prisma.user.create({ data: { phoneNumber: `TEST-SAVINGS-STRATEGIES-DUP-${suffix}` } })).id;
    otherUserId = (await prisma.user.create({ data: { phoneNumber: `TEST-SAVINGS-STRATEGIES-DUP-OTHER-${suffix}` } })).id;
  });

  afterEach(async () => {
    await prisma.savingsStrategy.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it("createSavingsStrategy throws when an active strategy of the same formulaType already exists, and creates nothing", async () => {
    await createSavingsStrategy(userId, { formulaType: "fifty_thirty_twenty", targetPercent: 20 });

    await expect(createSavingsStrategy(userId, { formulaType: "fifty_thirty_twenty", targetPercent: 30 })).rejects.toThrow(
      DuplicateActiveStrategyError
    );
    // Explicit status: "active" hits the same check as the default.
    await expect(
      createSavingsStrategy(userId, { formulaType: "fifty_thirty_twenty", targetPercent: 30, status: "active" })
    ).rejects.toThrow(DuplicateActiveStrategyError);

    expect(await prisma.savingsStrategy.count({ where: { userId, formulaType: "fifty_thirty_twenty" } })).toBe(1);
  });

  it("createSavingsStrategy still allows a different formulaType, a non-active duplicate, and another user's same formulaType", async () => {
    await createSavingsStrategy(userId, { formulaType: "fifty_thirty_twenty", targetPercent: 20 });

    await expect(createSavingsStrategy(userId, { formulaType: "leftover", targetAmount: 100_000 })).resolves.toBeDefined();
    await expect(
      createSavingsStrategy(userId, { formulaType: "fifty_thirty_twenty", targetPercent: 30, status: "paused" })
    ).resolves.toBeDefined();
    await expect(
      createSavingsStrategy(otherUserId, { formulaType: "fifty_thirty_twenty", targetPercent: 20 })
    ).resolves.toBeDefined();
  });

  it("createSavingsStrategy ignores a paused/abandoned strategy of the same formulaType when creating an active one", async () => {
    await createSavingsStrategy(userId, { formulaType: "roundup", targetPercent: 5, status: "paused" });
    await createSavingsStrategy(userId, { formulaType: "roundup", targetPercent: 5, status: "abandoned" });

    await expect(createSavingsStrategy(userId, { formulaType: "roundup", targetPercent: 5 })).resolves.toBeDefined();
  });

  it("updateSavingsStrategy throws when reactivating a paused row while another active one of the same formulaType exists", async () => {
    const paused = await createSavingsStrategy(userId, { formulaType: "custom", targetAmount: 100_000, status: "paused" });
    await createSavingsStrategy(userId, { formulaType: "custom", targetAmount: 200_000 });

    await expect(updateSavingsStrategy(userId, paused.id, { status: "active" })).rejects.toThrow(
      DuplicateActiveStrategyError
    );
    expect((await prisma.savingsStrategy.findUnique({ where: { id: paused.id } }))?.status).toBe("paused");
  });

  it("updateSavingsStrategy throws when switching a paused row's formulaType to one that's already active elsewhere", async () => {
    await createSavingsStrategy(userId, { formulaType: "leftover", targetAmount: 100_000 });
    const paused = await createSavingsStrategy(userId, { formulaType: "custom", targetAmount: 50_000, status: "paused" });

    // Resulting status is still the row's own "paused" - fine.
    await expect(updateSavingsStrategy(userId, paused.id, { formulaType: "leftover" })).resolves.toBeDefined();
    // ...but combined with (or already being) active, it's a duplicate.
    await expect(updateSavingsStrategy(userId, paused.id, { status: "active" })).rejects.toThrow(
      DuplicateActiveStrategyError
    );

    const active = await createSavingsStrategy(userId, { formulaType: "roundup", targetPercent: 5 });
    await expect(updateSavingsStrategy(userId, active.id, { formulaType: "leftover" })).rejects.toThrow(
      DuplicateActiveStrategyError
    );
    expect((await prisma.savingsStrategy.findUnique({ where: { id: active.id } }))?.formulaType).toBe("roundup");
  });

  it("updateSavingsStrategy doesn't flag an active row as a duplicate of itself, and allows pausing/reactivating when it's the only one", async () => {
    const strategy = await createSavingsStrategy(userId, { formulaType: "fifty_thirty_twenty", targetPercent: 20 });

    await expect(updateSavingsStrategy(userId, strategy.id, { targetPercent: 25 })).resolves.toBeDefined();
    await expect(updateSavingsStrategy(userId, strategy.id, { status: "paused" })).resolves.toBeDefined();
    await expect(updateSavingsStrategy(userId, strategy.id, { status: "active" })).resolves.toBeDefined();
  });
});

describe("updateSavingsStrategy / deleteSavingsStrategy - not found", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-SAVINGS-STRATEGIES-NOTFOUND-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
  });

  it("updateSavingsStrategy throws SavingsStrategyNotFoundError for a non-existent id", async () => {
    await expect(updateSavingsStrategy(userId, 999_999_999, { status: "paused" })).rejects.toThrow(
      SavingsStrategyNotFoundError
    );
  });

  it("deleteSavingsStrategy throws SavingsStrategyNotFoundError for a non-existent id", async () => {
    await expect(deleteSavingsStrategy(userId, 999_999_999)).rejects.toThrow(SavingsStrategyNotFoundError);
  });
});
