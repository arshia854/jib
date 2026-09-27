import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getLivePrices, LivePriceUnavailableError } from "@/lib/prices/get-live-prices";

// Lightweight companion to GET /api/assets: just the raw per-unit live
// prices (gold/usd/bitcoin), with no dependency on the caller already
// owning an asset of that type. Used by assets-manager.tsx to prefill
// "قیمت خرید" when the user is adding a *new* gold/usd/bitcoin asset -
// GET /api/assets can't serve that case because it only ever returns
// currentValue for assets the user already has, not the bare per-unit price.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  try {
    const prices = await getLivePrices();
    return NextResponse.json({
      unavailable: false,
      goldGramPricePerUnit: prices.goldGramPricePerUnit,
      usdPricePerUnit: prices.usdPricePerUnit,
      bitcoinPricePerUnit: prices.bitcoinPricePerUnit,
      stale: prices.stale,
    });
  } catch (error) {
    // Same graceful-degradation contract as lib/data/assets.ts: no live
    // price is not a server error, just nothing to prefill with (the form
    // still works fine with a manually-typed price) - getLivePrices()
    // already reported the underlying failure itself.
    if (error instanceof LivePriceUnavailableError) {
      return NextResponse.json({ unavailable: true });
    }
    throw error;
  }
}
