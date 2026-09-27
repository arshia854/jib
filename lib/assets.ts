// Fixed vocabulary for Asset.type (prisma/schema.prisma) - mirrors
// lib/accounts.ts's ACCOUNT_TYPES exactly (same shape, same
// getXTypeIcon/getXTypeLabel helper pair) since components/assets/
// assets-manager.tsx's type picker is a direct copy of
// components/accounts/accounts-manager.tsx's own ACCOUNT_TYPES grid.
export type AssetType = "gold" | "usd" | "bitcoin" | "custom";

// The subset of AssetType that actually has a live price feed (see
// isLivePricedAssetType below) - i.e. every type except "custom". Shared by
// lib/ai/parse-transaction.ts (detecting "خریدم صد دلار برای
// سرمایه‌گذاری"-style messages as an asset purchase) and
// lib/data/transactions.ts (creating the resulting Asset row), so both
// layers reference the same three-value vocabulary instead of each
// re-declaring their own "gold" | "usd" | "bitcoin" literal union.
export type LivePricedAssetType = Exclude<AssetType, "custom">;

export interface AssetTypeOption {
  value: AssetType;
  label: string;
  icon: string;
  // Unit the quantity is entered/displayed in. Empty for "custom" - a
  // manually-tracked asset has no fixed unit convention, quantity there is
  // just whatever multiplier the user means by it (shares, cars, ...).
  unitLabel: string;
  // Whether this type's current price comes live from
  // lib/prices/get-live-prices.ts (true) or is entered/updated by hand on
  // the Asset row itself via Asset.currentPricePerUnit (false, "custom"
  // only).
  isLivePriced: boolean;
}

export const ASSET_TYPES: AssetTypeOption[] = [
  { value: "gold", label: "طلا (۱۸ عیار)", icon: "🪙", unitLabel: "گرم", isLivePriced: true },
  { value: "usd", label: "دلار", icon: "💵", unitLabel: "دلار", isLivePriced: true },
  { value: "bitcoin", label: "بیت‌کوین", icon: "₿", unitLabel: "بیت‌کوین", isLivePriced: true },
  { value: "custom", label: "سایر (دستی)", icon: "⭐", unitLabel: "", isLivePriced: false },
];

export function getAssetTypeOption(type: string): AssetTypeOption | undefined {
  return ASSET_TYPES.find((t) => t.value === type);
}

export function getAssetTypeIcon(type: string): string {
  return getAssetTypeOption(type)?.icon ?? "📦";
}

export function getAssetTypeLabel(type: string): string {
  return getAssetTypeOption(type)?.label ?? type;
}

export function isLivePricedAssetType(type: string): boolean {
  return getAssetTypeOption(type)?.isLivePriced ?? false;
}
