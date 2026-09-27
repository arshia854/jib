import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

// getLivePrices() itself is covered by lib/prices/get-live-prices.test.ts -
// mocked here so this file's tests exercise listAssetsWithValue()'s own
// current-value/cost-basis/profit-loss math against known, fixed prices
// instead of depending on an external API or its DB-backed cache.
vi.mock("@/lib/prices/get-live-prices", async () => {
  const actual = await vi.importActual<typeof import("@/lib/prices/get-live-prices")>("@/lib/prices/get-live-prices");
  return { ...actual, getLivePrices: vi.fn() };
});

import { prisma } from "@/lib/prisma";
import {
  listAssetsWithValue,
  createAsset,
  updateAsset,
  deleteAsset,
  AssetNotFoundError,
} from "@/lib/data/assets";
import { getLivePrices, LivePriceUnavailableError } from "@/lib/prices/get-live-prices";

const mockedGetLivePrices = vi.mocked(getLivePrices);

const FIXED_PRICES = {
  goldGramPricePerUnit: 5_000_000,
  usdPricePerUnit: 700_000,
  bitcoinPricePerUnit: 80_000_000_000,
  fetchedAt: new Date(),
  stale: false,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("cross-user ownership", () => {
  let userAId: number;
  let userBId: number;
  let assetAId: number;

  beforeAll(async () => {
    const userA = await prisma.user.create({ data: { phoneNumber: `TEST-ASSET-OWNERSHIP-A-${Date.now()}` } });
    userAId = userA.id;
    const userB = await prisma.user.create({ data: { phoneNumber: `TEST-ASSET-OWNERSHIP-B-${Date.now()}` } });
    userBId = userB.id;

    const assetA = await createAsset(userAId, {
      type: "custom",
      name: "دارایی الف",
      quantity: 1,
      purchasePricePerUnit: 1_000_000,
    });
    assetAId = assetA.id;
  }, 20000);

  afterAll(async () => {
    await prisma.asset.deleteMany({ where: { userId: { in: [userAId, userBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await prisma.$disconnect();
  }, 20000);

  it(
    "updateAsset throws AssetNotFoundError when called by another user, and leaves the row untouched",
    async () => {
      await expect(updateAsset(userBId, assetAId, { name: "دستکاری شده" })).rejects.toBeInstanceOf(
        AssetNotFoundError
      );
      const untouched = await prisma.asset.findUnique({ where: { id: assetAId } });
      expect(untouched?.name).toBe("دارایی الف");
    },
    15000
  );

  it(
    "deleteAsset throws AssetNotFoundError when called by another user, and the row still exists after",
    async () => {
      await expect(deleteAsset(userBId, assetAId)).rejects.toBeInstanceOf(AssetNotFoundError);
      expect(await prisma.asset.findUnique({ where: { id: assetAId } })).not.toBeNull();
    },
    15000
  );

  it(
    "the owner can still update their own asset (sanity check the block above is ownership-specific)",
    async () => {
      const updated = await updateAsset(userAId, assetAId, { name: "دارایی الف - ویرایش شده" });
      expect(updated.name).toBe("دارایی الف - ویرایش شده");
    },
    15000
  );
});

describe("createAsset - BigInt price round-trip", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-ASSET-BIGINT-${Date.now()}` } });
    userId = user.id;
  }, 20000);

  afterAll(async () => {
    await prisma.asset.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }, 20000);

  it(
    "stores and returns a per-BTC-sized Toman price (well beyond Int32's ~2.147 billion ceiling) intact",
    async () => {
      const hugePrice = 80_000_000_000; // ~80 billion Toman - exceeds Int32, the whole reason this column is BigInt.
      const asset = await createAsset(userId, {
        type: "bitcoin",
        quantity: 0.01,
        purchasePricePerUnit: hugePrice,
      });
      expect(asset.purchasePricePerUnit).toBe(hugePrice);

      const row = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
      expect(row.purchasePricePerUnit).toBe(BigInt(hugePrice));
    },
    15000
  );

  it(
    "defaults a custom asset's currentPricePerUnit to purchasePricePerUnit when omitted (0 profit/loss until updated)",
    async () => {
      const asset = await createAsset(userId, {
        type: "custom",
        name: "دارایی بدون ارزش فعلی",
        quantity: 2,
        purchasePricePerUnit: 300_000,
      });
      expect(asset.currentPricePerUnit).toBe(300_000);
    },
    15000
  );
});

describe("listAssetsWithValue", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-ASSET-LIST-${Date.now()}` } });
    userId = user.id;

    await Promise.all([
      // 2 grams bought at 4,000,000/gram -> cost basis 8,000,000; live price
      // 5,000,000/gram -> current value 10,000,000 -> +2,000,000 (+25%).
      createAsset(userId, { type: "gold", quantity: 2, purchasePricePerUnit: 4_000_000 }),
      // 100 USD bought at 800,000/unit -> cost basis 80,000,000; live price
      // 700,000/unit -> current value 70,000,000 -> -10,000,000 (-12.5%).
      createAsset(userId, { type: "usd", quantity: 100, purchasePricePerUnit: 800_000 }),
      // Custom asset with an explicit current value: cost basis 1,000,000,
      // current value 1,200,000 -> +200,000 (+20%). No live price involved.
      createAsset(userId, {
        type: "custom",
        name: "دارایی سفارشی تست لیست",
        quantity: 1,
        purchasePricePerUnit: 1_000_000,
        currentPricePerUnit: 1_200_000,
      }),
    ]);
  }, 20000);

  afterAll(async () => {
    await prisma.asset.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }, 20000);

  it(
    "computes currentValue/costBasis/profitLoss per row and portfolio totals using live prices for gold/usd only",
    async () => {
      mockedGetLivePrices.mockResolvedValue(FIXED_PRICES);

      const summary = await listAssetsWithValue(userId);
      expect(mockedGetLivePrices).toHaveBeenCalledTimes(1);

      const gold = summary.assets.find((a) => a.type === "gold");
      expect(gold).toMatchObject({ costBasis: 8_000_000, currentValue: 10_000_000, profitLossToman: 2_000_000 });
      expect(gold?.profitLossPercent).toBeCloseTo(25, 5);

      const usd = summary.assets.find((a) => a.type === "usd");
      expect(usd).toMatchObject({ costBasis: 80_000_000, currentValue: 70_000_000, profitLossToman: -10_000_000 });
      expect(usd?.profitLossPercent).toBeCloseTo(-12.5, 5);

      const custom = summary.assets.find((a) => a.type === "custom");
      expect(custom).toMatchObject({ costBasis: 1_000_000, currentValue: 1_200_000, profitLossToman: 200_000 });
      expect(custom?.profitLossPercent).toBeCloseTo(20, 5);

      // Totals: cost basis 8,000,000 + 80,000,000 + 1,000,000 = 89,000,000;
      // value 10,000,000 + 70,000,000 + 1,200,000 = 81,200,000; P/L = -7,800,000.
      expect(summary.totalCostBasis).toBe(89_000_000);
      expect(summary.totalValue).toBe(81_200_000);
      expect(summary.totalProfitLossToman).toBe(-7_800_000);
      expect(summary.priceUnavailable).toBe(false);
      expect(summary.priceStale).toBe(false);
    },
    15000
  );

  it(
    "does not call getLivePrices at all when the user only holds custom assets",
    async () => {
      const onlyCustomUser = await prisma.user.create({
        data: { phoneNumber: `TEST-ASSET-CUSTOM-ONLY-${Date.now()}` },
      });
      try {
        await createAsset(onlyCustomUser.id, {
          type: "custom",
          name: "فقط دستی",
          quantity: 1,
          purchasePricePerUnit: 500_000,
          currentPricePerUnit: 600_000,
        });

        const summary = await listAssetsWithValue(onlyCustomUser.id);
        expect(mockedGetLivePrices).not.toHaveBeenCalled();
        expect(summary.assets[0]).toMatchObject({ currentValue: 600_000, profitLossToman: 100_000 });
      } finally {
        await prisma.asset.deleteMany({ where: { userId: onlyCustomUser.id } });
        await prisma.user.delete({ where: { id: onlyCustomUser.id } });
      }
    },
    15000
  );

  it(
    "degrades gracefully (priceUnavailable: true, null values for live-priced rows) when getLivePrices() throws",
    async () => {
      mockedGetLivePrices.mockRejectedValue(new LivePriceUnavailableError("unavailable"));

      const summary = await listAssetsWithValue(userId);

      const gold = summary.assets.find((a) => a.type === "gold");
      expect(gold).toMatchObject({ currentValue: null, profitLossToman: null, profitLossPercent: null });

      const custom = summary.assets.find((a) => a.type === "custom");
      expect(custom).toMatchObject({ currentValue: 1_200_000 });

      expect(summary.priceUnavailable).toBe(true);
      // Unpriced rows fall back to costBasis in the portfolio total (gold
      // 8,000,000 + usd 80,000,000 both at cost, custom at its own current
      // value 1,200,000).
      expect(summary.totalValue).toBe(8_000_000 + 80_000_000 + 1_200_000);
    },
    15000
  );
});
