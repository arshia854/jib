import "server-only";
import { prisma } from "@/lib/prisma";
import { getLivePrices, LivePriceUnavailableError, type LivePrices } from "@/lib/prices/get-live-prices";
import { isLivePricedAssetType, type LivePricedAssetType } from "@/lib/assets";

type PrismaClient = typeof prisma;

export class AssetNotFoundError extends Error {}

// Prisma Client returns Asset.purchasePricePerUnit/currentPricePerUnit as
// real JS `bigint` (see prisma/schema.prisma's comment on why those two
// columns are BigInt, not Int) - `bigint` can't survive
// `NextResponse.json()` (JSON.stringify throws on it), and every value this
// app will ever actually see is far below Number.MAX_SAFE_INTEGER (enforced
// by MAX_ASSET_PRICE_PER_UNIT in lib/limits.ts), so every row is converted
// to plain `number` right here, once, rather than leaking `bigint` out of
// this module for every caller to handle separately.
export interface SerializedAsset {
  id: number;
  type: string;
  name: string | null;
  quantity: number;
  purchasePricePerUnit: number;
  purchaseDate: Date;
  currentPricePerUnit: number | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AssetRow {
  id: number;
  type: string;
  name: string | null;
  quantity: number;
  purchasePricePerUnit: bigint;
  purchaseDate: Date;
  currentPricePerUnit: bigint | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function serializeAsset(row: AssetRow): SerializedAsset {
  return {
    ...row,
    purchasePricePerUnit: Number(row.purchasePricePerUnit),
    currentPricePerUnit: row.currentPricePerUnit !== null ? Number(row.currentPricePerUnit) : null,
  };
}

function livePriceForType(type: string, prices: LivePrices): number {
  switch (type) {
    case "gold":
      return prices.goldGramPricePerUnit;
    case "usd":
      return prices.usdPricePerUnit;
    case "bitcoin":
      return prices.bitcoinPricePerUnit;
    default:
      return 0;
  }
}

export interface AssetWithValue extends SerializedAsset {
  // Null only when this is a live-priced type (gold/usd/bitcoin) and
  // getLivePrices() couldn't produce a price at all (LivePriceUnavailableError
  // - see priceUnavailable on AssetsSummary below); always a number for
  // "custom" assets, which always carry their own currentPricePerUnit.
  currentValue: number | null;
  costBasis: number;
  profitLossToman: number | null;
  profitLossPercent: number | null;
}

export interface AssetsSummary {
  assets: AssetWithValue[];
  totalValue: number;
  totalCostBasis: number;
  totalProfitLossToman: number;
  totalProfitLossPercent: number | null;
  // True when the prices used are older than the normal cache TTL because a
  // fresh fetch just failed (see lib/prices/get-live-prices.ts's own
  // `stale` field) - distinct from priceUnavailable below.
  priceStale: boolean;
  // True when there's at least one live-priced asset (gold/usd/bitcoin) and
  // no price - fresh or cached - could be obtained at all. Those assets'
  // currentValue/profitLoss* are null; the UI shows a fallback notice
  // instead of a number.
  priceUnavailable: boolean;
}

// Reads every asset the user holds and attaches its live-computed current
// value / cost basis / profit-loss (Toman + percent), plus portfolio-level
// totals. Fetches live prices at most once per call (not once per row) -
// getLivePrices() itself is the thing that's actually cached (see
// lib/prices/get-live-prices.ts), this just avoids calling it redundantly
// when the user holds several gold/usd/bitcoin lots at once.
export async function listAssetsWithValue(userId: number, client: PrismaClient = prisma): Promise<AssetsSummary> {
  const rows = await client.asset.findMany({
    where: { userId },
    orderBy: [{ type: "asc" }, { purchaseDate: "desc" }],
  });

  let livePrices: LivePrices | null = null;
  let priceUnavailable = false;
  if (rows.some((row) => isLivePricedAssetType(row.type))) {
    try {
      livePrices = await getLivePrices(client);
    } catch (error) {
      if (!(error instanceof LivePriceUnavailableError)) throw error;
      priceUnavailable = true;
    }
  }

  const assets: AssetWithValue[] = rows.map((row) => {
    const serialized = serializeAsset(row);
    const costBasis = serialized.quantity * serialized.purchasePricePerUnit;

    const currentPricePerUnit = isLivePricedAssetType(row.type)
      ? (livePrices ? livePriceForType(row.type, livePrices) : null)
      : serialized.currentPricePerUnit;

    const currentValue = currentPricePerUnit !== null ? serialized.quantity * currentPricePerUnit : null;
    const profitLossToman = currentValue !== null ? currentValue - costBasis : null;
    const profitLossPercent =
      profitLossToman === null ? null : costBasis > 0 ? (profitLossToman / costBasis) * 100 : 0;

    return { ...serialized, currentValue, costBasis, profitLossToman, profitLossPercent };
  });

  const totalCostBasis = assets.reduce((sum, a) => sum + a.costBasis, 0);
  // Assets whose current value is unknown (priceUnavailable) still count at
  // cost basis in the portfolio total - understating an unknown gain/loss
  // as "unchanged" is safer than either silently dropping the row from the
  // total or pretending 0.
  const totalValue = assets.reduce((sum, a) => sum + (a.currentValue ?? a.costBasis), 0);
  const totalProfitLossToman = totalValue - totalCostBasis;
  const totalProfitLossPercent = totalCostBasis > 0 ? (totalProfitLossToman / totalCostBasis) * 100 : null;

  return {
    assets,
    totalValue,
    totalCostBasis,
    totalProfitLossToman,
    totalProfitLossPercent,
    priceStale: livePrices?.stale ?? false,
    priceUnavailable,
  };
}

export interface CreateAssetInput {
  type: string;
  name?: string | null;
  quantity: number;
  purchasePricePerUnit: number;
  purchaseDate?: Date;
  // "custom" only - see the field's own comment on Asset in schema.prisma.
  // Defaults to purchasePricePerUnit when omitted, so a freshly-added
  // manual asset starts at exactly 0 profit/loss until the user updates it,
  // rather than being left at a meaningless null.
  currentPricePerUnit?: number;
  note?: string | null;
}

export async function createAsset(userId: number, data: CreateAssetInput): Promise<SerializedAsset> {
  const isCustom = data.type === "custom";
  const row = await prisma.asset.create({
    data: {
      userId,
      type: data.type,
      name: isCustom ? (data.name ?? null) : null,
      quantity: data.quantity,
      purchasePricePerUnit: BigInt(Math.round(data.purchasePricePerUnit)),
      purchaseDate: data.purchaseDate ?? new Date(),
      currentPricePerUnit: isCustom
        ? BigInt(Math.round(data.currentPricePerUnit ?? data.purchasePricePerUnit))
        : null,
      note: data.note ?? null,
    },
  });
  return serializeAsset(row);
}

export interface UpdateAssetInput {
  name?: string | null;
  quantity?: number;
  purchasePricePerUnit?: number;
  purchaseDate?: Date;
  currentPricePerUnit?: number;
  note?: string | null;
}

export async function updateAsset(userId: number, id: number, data: UpdateAssetInput): Promise<SerializedAsset> {
  const existing = await prisma.asset.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new AssetNotFoundError("دارایی یافت نشد.");
  }

  const row = await prisma.asset.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.quantity !== undefined && { quantity: data.quantity }),
      ...(data.purchasePricePerUnit !== undefined && {
        purchasePricePerUnit: BigInt(Math.round(data.purchasePricePerUnit)),
      }),
      ...(data.purchaseDate !== undefined && { purchaseDate: data.purchaseDate }),
      ...(data.currentPricePerUnit !== undefined && {
        currentPricePerUnit: BigInt(Math.round(data.currentPricePerUnit)),
      }),
      ...(data.note !== undefined && { note: data.note }),
    },
  });
  return serializeAsset(row);
}

// Exported for lib/data/transactions.ts's createTransaction() - when a
// detected asset purchase (lib/ai/parse-transaction.ts's assetSuggestion) is
// confirmed, it needs to create a Transaction row AND an Asset row in the
// same atomic prisma.$transaction([...]) call, so it can't go through
// createAsset() above (a separate, independently-awaited call). This just
// factors out the same BigInt-rounding/default-field convention createAsset
// already uses, so both call sites build a row the exact same way instead of
// keeping two copies in sync by hand. Always type/name/currentPricePerUnit
// as a live-priced type (no "custom" via this path - see
// LivePricedAssetType), matching createAsset's own isCustom branch.
export function buildAssetCreateData(
  userId: number,
  input: { type: LivePricedAssetType; quantity: number; purchasePricePerUnit: number; purchaseDate?: Date }
) {
  return {
    userId,
    type: input.type,
    name: null,
    quantity: input.quantity,
    purchasePricePerUnit: BigInt(Math.round(input.purchasePricePerUnit)),
    purchaseDate: input.purchaseDate ?? new Date(),
    currentPricePerUnit: null,
    note: null,
  };
}

export async function deleteAsset(userId: number, id: number): Promise<void> {
  const existing = await prisma.asset.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new AssetNotFoundError("دارایی یافت نشد.");
  }
  await prisma.asset.delete({ where: { id } });
}
