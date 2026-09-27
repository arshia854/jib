"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, TrashIcon, XIcon, CheckIcon, SpinnerIcon, ChartIcon, RefreshIcon, AlertIcon } from "@/components/icons";
import { EmptyState } from "@/components/empty-state";
import { ASSET_TYPES, getAssetTypeIcon, getAssetTypeLabel, getAssetTypeOption, type AssetType } from "@/lib/assets";
import { toJalaali } from "jalaali-js";
import {
  formatToman,
  formatNumber,
  formatDecimal,
  formatCompactToman,
  formatJalaaliDate,
  formatJalaaliDateShort,
} from "@/lib/format";
import { AmountInput } from "@/components/ui/amount-input";
import { JalaliDatePicker } from "@/components/goals/jalali-date-picker";
import { AssetsHeroCard, type AllocationSlice } from "./assets-hero-card";
import { LivePricesCard, type TickerEntry } from "./live-prices-card";
import { ProfitLossBadge } from "./profit-loss-badge";

interface Asset {
  id: number;
  type: string;
  name: string | null;
  quantity: number;
  purchasePricePerUnit: number;
  purchaseDate: Date | string;
  currentPricePerUnit: number | null;
  note: string | null;
  currentValue: number | null;
  costBasis: number;
  profitLossToman: number | null;
  profitLossPercent: number | null;
}

interface AssetsSummary {
  assets: Asset[];
  totalValue: number;
  totalCostBasis: number;
  totalProfitLossToman: number;
  totalProfitLossPercent: number | null;
  priceStale: boolean;
  priceUnavailable: boolean;
}

interface FormState {
  id: number | null;
  type: AssetType;
  name: string;
  quantity: string;
  // "quantity" (type it directly, default) vs "amount" (type a total toman
  // amount and let it be divided by purchasePricePerUnit) - only offered for
  // a *new* asset of a live-priced type, see showAmountEntry below.
  entryMode: "quantity" | "amount";
  totalAmount: string;
  purchasePricePerUnit: string;
  purchaseDate: string;
  currentPricePerUnit: string;
  note: string;
  // Only meaningful for form.type === "gold" - lets the quantity input
  // accept milligrams while storage/API/validation always stay in grams
  // (see handleSave's conversion). Defaults to "gram" and resets to it
  // whenever gold isn't the selected type, so it never silently applies to
  // another type's quantity.
  quantityUnit: "gram" | "milligram";
}

// GET /api/assets/live-prices response shape (app/api/assets/live-prices/route.ts).
interface LivePricesResponse {
  unavailable: boolean;
  goldGramPricePerUnit?: number;
  usdPricePerUnit?: number;
  bitcoinPricePerUnit?: number;
  stale?: boolean;
}

// Maps a live-priced AssetType to its field on LivePricesResponse.
const LIVE_PRICE_FIELD: Partial<Record<AssetType, keyof LivePricesResponse>> = {
  gold: "goldGramPricePerUnit",
  usd: "usdPricePerUnit",
  bitcoin: "bitcoinPricePerUnit",
};

function todayInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toInputDate(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyForm(): FormState {
  return {
    id: null,
    type: "gold",
    name: "",
    quantity: "",
    entryMode: "quantity",
    totalAmount: "",
    purchasePricePerUnit: "",
    purchaseDate: todayInputValue(),
    currentPricePerUnit: "",
    note: "",
    quantityUnit: "gram",
  };
}

// Toman/price input: comma-grouped display + digit-only parsing, the same
// pattern as add-transaction-form.tsx's live-preview amount input.
function MoneyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (digits: string) => void;
}) {
  return (
    <>
      <label className="mt-4 block text-xs text-muted">{label}</label>
      <AmountInput value={Number(value) || 0} onChange={(next) => onChange(next ? String(next) : "")} />
    </>
  );
}

// A purchase date is almost always today or recent - same shape as
// add-transaction-form.tsx's TRANSACTION_QUICK_SELECT_OPTIONS.
const PURCHASE_DATE_QUICK_SELECT_OPTIONS = [
  { label: "امروز", getDate: (today: Date) => today },
  {
    label: "دیروز",
    getDate: (today: Date) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1),
  },
  {
    label: "هفته پیش",
    getDate: (today: Date) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7),
  },
];

// Same `currentValue ?? costBasis` fallback listAssetsWithValue uses for
// totalValue (lib/data/assets.ts), so per-type sums and the hero's headline
// total always agree even while live prices are unavailable.
function valueForTotals(asset: Asset): number {
  return asset.currentValue ?? asset.costBasis;
}

function valueByType(assets: Asset[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const asset of assets) totals.set(asset.type, (totals.get(asset.type) ?? 0) + valueForTotals(asset));
  return totals;
}

// Hero card's "ترکیب سبد" bar: one slice per asset type, largest first.
function deriveAllocation(assets: Asset[]): AllocationSlice[] {
  return [...valueByType(assets)]
    .map(([type, value]) => ({ type, value, label: type === "custom" ? "سایر" : getAssetTypeLabel(type) }))
    .sort((a, b) => b.value - a.value);
}

// Holdings list order: types by their total value (the same order as the
// hero's allocation legend), keeping every lot of one type together - a
// flat value sort would split e.g. two gold lots apart around a dollar one.
// Within a type the server's own order (purchaseDate desc) is kept, since
// Array.prototype.sort is stable.
function orderHoldings(assets: Asset[]): Asset[] {
  const totals = valueByType(assets);
  return [...assets].sort((a, b) => (totals.get(b.type) ?? 0) - (totals.get(a.type) ?? 0));
}

// Holdings-row date: "۹ مرداد" for this Jalali year, "۲۴ اسفند ۱۴۰۴" for an
// older one - the year only earns its width when it's not the current one,
// and dropping it keeps the row's subtitle from truncating at 360px.
function formatPurchaseDate(date: Date | string): string {
  const isThisYear = toJalaali(new Date(date)).jy === toJalaali(new Date()).jy;
  return isThisYear ? formatJalaaliDateShort(date) : formatJalaaliDate(date);
}

function assetDisplayName(asset: Asset): string {
  return asset.type === "custom" ? (asset.name ?? getAssetTypeLabel(asset.type)) : getAssetTypeLabel(asset.type);
}

// Builds LivePricesCard's entries: one tile per
// live-priced type (طلا/دلار/بیت‌کوین) the user actually holds, reusing
// listAssetsWithValue's already-computed currentValue instead of a second
// fetch - every lot of the same type shares one live price (one shared
// getLivePrices() call per listAssetsWithValue run), so the first priced lot
// found for a type gives that type's exact price per unit.
function deriveTickerEntries(assets: Asset[]): TickerEntry[] {
  const seen = new Set<string>();
  const entries: TickerEntry[] = [];
  for (const asset of assets) {
    if (seen.has(asset.type) || asset.currentValue === null || asset.quantity <= 0) continue;
    const option = getAssetTypeOption(asset.type);
    if (!option || !option.isLivePriced) continue;
    seen.add(asset.type);
    entries.push({
      type: asset.type,
      label: option.label,
      icon: option.icon,
      unitLabel: option.unitLabel,
      pricePerUnit: asset.currentValue / asset.quantity,
    });
  }
  return entries;
}

export function AssetsManager({ summary }: { summary: AssetsSummary }) {
  const router = useRouter();
  const tickerEntries = deriveTickerEntries(summary.assets);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Delete lives inside the edit sheet (not as a one-tap icon on every row,
  // which used to delete immediately with no confirmation) - two steps,
  // same confirm-then-delete idea as goals-manager.tsx's GoalCard.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [livePrices, setLivePrices] = useState<LivePricesResponse | null>(null);
  const [livePricesLoading, setLivePricesLoading] = useState(false);

  // Auto-fills "قیمت خرید" with today's live price the moment a live-priced
  // type (طلا/دلار/بیت‌کوین) is selected on a *new* asset and the field is
  // still empty - this is what was missing: the price used to sit blank,
  // forcing the user to go look up and type today's gold price by hand.
  // Applied at the two moments that can newly satisfy it (prices just
  // arrived, or the type was just switched to a live-priced one) rather
  // than an effect watching everything. Never runs on edit (an existing
  // asset's purchase price is historical, not "today"), and never
  // overwrites a value the user already typed.
  function prefillFromLivePrice(prices: LivePricesResponse, type: AssetType) {
    if (prices.unavailable) return;
    const field = LIVE_PRICE_FIELD[type];
    const price = field ? prices[field] : undefined;
    if (typeof price !== "number") return;
    setForm((f) =>
      f && f.id === null && f.type === type && !f.purchasePricePerUnit
        ? { ...f, purchasePricePerUnit: String(Math.round(price)) }
        : f
    );
  }

  function openCreate() {
    setForm(emptyForm());
    setError(null);
    setConfirmingDelete(false);
    // Fetched fresh per "add" tap (not once for the whole page) - prices
    // move and the create form can stay open a while. Only ever used to
    // prefill/offer a value for purchasePricePerUnit below, never blocks
    // the form if it fails.
    setLivePrices(null);
    setLivePricesLoading(true);
    fetch("/api/assets/live-prices")
      .then((res) => res.json())
      .then((data: LivePricesResponse) => {
        setLivePrices(data);
        prefillFromLivePrice(data, "gold"); // emptyForm()'s default type
      })
      .catch(() => setLivePrices({ unavailable: true }))
      .finally(() => setLivePricesLoading(false));
  }

  function selectType(type: AssetType) {
    // entryMode resets to "quantity" on every type switch - staying in
    // "amount" mode with a stale computed quantity from the previous type
    // (different unit, different price) would be confusing. quantityUnit
    // resets to "gram" the same way - it only applies to gold, so switching
    // away from (or back to) gold should never carry a stale "milligram"
    // selection with it.
    setForm((f) => (f ? { ...f, type, entryMode: "quantity", quantityUnit: "gram" } : f));
    if (livePrices) prefillFromLivePrice(livePrices, type);
  }

  // Manual "استفاده از قیمت لحظه‌ای" chip below the field - lets the user
  // reset back to today's live price even after typing over it.
  function applyLivePrice() {
    if (!form) return;
    const field = LIVE_PRICE_FIELD[form.type];
    const price = field && livePrices && !livePrices.unavailable ? livePrices[field] : undefined;
    if (typeof price !== "number") return;
    setForm({ ...form, purchasePricePerUnit: String(Math.round(price)) });
  }

  function openEdit(asset: Asset) {
    setForm({
      id: asset.id,
      type: asset.type as AssetType,
      name: asset.name ?? "",
      quantity: String(asset.quantity),
      // Edit is create-only-excluded for this feature, same as the live-price
      // prefill above - always the raw stored quantity, never the calculator.
      entryMode: "quantity",
      totalAmount: "",
      // Editing always starts from the stored gram value shown as grams -
      // never assume/reconstruct a milligram entry the asset may have
      // originally been typed in.
      quantityUnit: "gram",
      purchasePricePerUnit: String(asset.purchasePricePerUnit),
      purchaseDate: toInputDate(asset.purchaseDate),
      currentPricePerUnit: asset.currentPricePerUnit !== null ? String(asset.currentPricePerUnit) : "",
      note: asset.note ?? "",
    });
    setError(null);
    setConfirmingDelete(false);
  }

  async function handleSave() {
    if (!form) return;
    const isCustom = form.type === "custom";

    if (isCustom && !form.name.trim()) {
      setError("برای دارایی دستی، نام الزامی است.");
      return;
    }
    let quantity: number;
    let purchasePricePerUnit: number;
    if (form.entryMode === "amount") {
      // Price is needed by the calculator itself, so it's validated first
      // here (unlike "quantity" mode below, which checks quantity first).
      purchasePricePerUnit = Number(form.purchasePricePerUnit);
      if (!Number.isFinite(purchasePricePerUnit) || purchasePricePerUnit <= 0) {
        setError("قیمت خرید نامعتبر است.");
        return;
      }
      const totalAmount = Number(form.totalAmount);
      quantity = Number.isFinite(totalAmount) && totalAmount > 0 ? totalAmount / purchasePricePerUnit : NaN;
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setError("مقدار دارایی نامعتبر است.");
        return;
      }
    } else {
      quantity = Number(form.quantity);
      // Storage/API/validation always operate in grams - milligram is only
      // ever a display/entry convenience on this field itself.
      if (form.type === "gold" && form.quantityUnit === "milligram") {
        quantity = quantity / 1000;
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setError("مقدار دارایی نامعتبر است.");
        return;
      }
      purchasePricePerUnit = Number(form.purchasePricePerUnit);
      if (!Number.isFinite(purchasePricePerUnit) || purchasePricePerUnit <= 0) {
        setError("قیمت خرید نامعتبر است.");
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const isEdit = form.id !== null;
      const payload: Record<string, unknown> = {
        type: form.type,
        quantity,
        purchasePricePerUnit,
        purchaseDate: form.purchaseDate,
        note: form.note.trim() || null,
      };
      if (isCustom) {
        payload.name = form.name.trim();
        if (form.currentPricePerUnit) payload.currentPricePerUnit = Number(form.currentPricePerUnit);
      }

      const res = await fetch(isEdit ? `/api/assets/${form.id}` : "/api/assets", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ذخیره‌سازی.");
      setForm(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!form || form.id === null) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/assets/${form.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در حذف.");
      setForm(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setDeleting(false);
    }
  }

  const isFormCustom = form?.type === "custom";
  // Only offered on a *new* asset of a live-priced type - see the prefill
  // effect above for why edit is excluded.
  const liveField = form && form.id === null ? LIVE_PRICE_FIELD[form.type] : undefined;
  const livePriceValue = liveField && livePrices && !livePrices.unavailable ? livePrices[liveField] : undefined;
  // Total-amount-to-quantity calculator: new asset + live-priced type only,
  // same scope as the live-price prefill (liveField above).
  const showAmountEntry = !!(form && form.id === null && getAssetTypeOption(form.type)?.isLivePriced);
  const purchasePriceNumber = form ? Number(form.purchasePricePerUnit) : NaN;
  const hasValidPurchasePrice =
    !!form && form.purchasePricePerUnit !== "" && Number.isFinite(purchasePriceNumber) && purchasePriceNumber > 0;
  // "مبلغ کل خرید" preview under the price field, quantity mode only (amount
  // mode already shows its own computed quantity). Mirrors handleSave's
  // milligram-to-gram conversion so it previews exactly what gets saved.
  const typedQuantity = form
    ? Number(form.quantity) / (form.type === "gold" && form.quantityUnit === "milligram" ? 1000 : 1)
    : NaN;
  const purchaseTotalPreview =
    form && form.entryMode === "quantity" && hasValidPurchasePrice && Number.isFinite(typedQuantity) && typedQuantity > 0
      ? typedQuantity * purchasePriceNumber
      : null;
  const busy = saving || deleting;
  const stalePrices = summary.priceStale && !summary.priceUnavailable;
  const holdings = orderHoldings(summary.assets);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">سبد دارایی</h2>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary shadow-sm shadow-primary/20 transition-transform active:scale-95"
        >
          <PlusIcon className="h-4 w-4" />
          افزودن دارایی
        </button>
      </div>

      {summary.assets.length === 0 ? (
        <EmptyState
          icon={<ChartIcon className="h-6 w-6" />}
          title="هنوز دارایی‌ای ثبت نکرده‌اید"
          description="طلا، دلار، بیت‌کوین یا هر دارایی دیگری که دارید را اضافه کنید تا ارزش لحظه‌ای و سود و زیانش را دنبال کنید."
          action={{ label: "افزودن اولین دارایی", onClick: openCreate }}
        />
      ) : (
        <>
          <AssetsHeroCard
            totalValue={summary.totalValue}
            totalCostBasis={summary.totalCostBasis}
            totalProfitLossToman={summary.totalProfitLossToman}
            totalProfitLossPercent={summary.totalProfitLossPercent}
            allocation={deriveAllocation(summary.assets)}
            priceStale={stalePrices}
            priceUnavailable={summary.priceUnavailable}
          />

          {summary.priceUnavailable && (
            <p className="flex items-start gap-2 rounded-xl bg-warning/10 p-3 text-xs text-warning">
              <AlertIcon className="mt-px h-4 w-4 shrink-0" />
              قیمت لحظه‌ای طلا/دلار/بیت‌کوین در دسترس نیست؛ سود و زیان این دارایی‌ها موقتاً قابل محاسبه نیست.
            </p>
          )}

          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-2 px-1">
              <h3 className="text-sm font-bold text-foreground">دارایی‌های من</h3>
              <span className="text-[11px] text-muted">برای ویرایش، روی هر مورد بزنید</span>
            </div>
            <ul className="divide-y divide-border rounded-2xl border border-border bg-surface px-4">
              {holdings.map((asset) => {
                const unitLabel = getAssetTypeOption(asset.type)?.unitLabel || "واحد";
                const hasProfitLoss = asset.profitLossToman !== null && asset.profitLossPercent !== null;
                const isProfit = (asset.profitLossToman ?? 0) >= 0;
                return (
                  <li key={asset.id}>
                    <button
                      type="button"
                      onClick={() => openEdit(asset)}
                      className="flex w-full items-center gap-3 py-3.5 text-start transition-opacity active:opacity-60"
                    >
                      <span className="sr-only">ویرایش </span>
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-background text-base">
                        {getAssetTypeIcon(asset.type)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {assetDisplayName(asset)}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted tabular-fa">
                          {formatDecimal(asset.quantity, 6)} {unitLabel}
                        </span>
                        {/* Purchase date is what tells two lots of the same
                            type apart (e.g. two gold rows) at a glance - its
                            own line, so it isn't the part that truncates at
                            360px. */}
                        <span className="mt-0.5 block truncate text-[11px] text-muted tabular-fa">
                          خرید {formatPurchaseDate(asset.purchaseDate)}
                        </span>
                        {asset.note && (
                          <span className="mt-0.5 block truncate text-[11px] text-muted">{asset.note}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-end">
                        <span className="block text-sm font-semibold tabular-fa text-foreground">
                          {asset.currentValue !== null ? formatNumber(asset.currentValue) : "—"}{" "}
                          <span className="text-[11px] font-normal text-muted">تومان</span>
                        </span>
                        {hasProfitLoss ? (
                          <span className="mt-1 flex items-center justify-end gap-1.5">
                            <span className={`text-[11px] tabular-fa ${isProfit ? "text-success" : "text-warning"}`}>
                              {formatCompactToman(Math.abs(asset.profitLossToman!))} {isProfit ? "سود" : "زیان"}
                            </span>
                            <ProfitLossBadge toman={asset.profitLossToman!} percent={asset.profitLossPercent!} />
                          </span>
                        ) : (
                          <span className="mt-1 block text-[11px] text-muted">قیمت نامشخص</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <LivePricesCard entries={tickerEntries} stale={stalePrices} />
        </>
      )}

      {form && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => !busy && setForm(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="asset-form-title"
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-border" />
            <div className="mb-4 flex items-center justify-between">
              <h2 id="asset-form-title" className="text-base font-bold text-foreground">
                {form.id ? "ویرایش دارایی" : "دارایی جدید"}
              </h2>
              <button onClick={() => setForm(null)} disabled={busy} aria-label="بستن">
                <XIcon className="h-5 w-5 text-muted" />
              </button>
            </div>

            <p className="mb-2 text-xs text-muted">نوع دارایی</p>
            <div className="grid grid-cols-2 gap-2">
              {ASSET_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => selectType(t.value)}
                  className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-medium ${
                    form.type === t.value ? "bg-primary text-on-primary" : "bg-background text-muted"
                  }`}
                >
                  <span>{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>

            {isFormCustom && (
              <>
                <label className="mt-4 block text-xs text-muted">نام دارایی</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="مثلاً سهام فولاد، خودرو"
                  className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
                />
              </>
            )}

            {showAmountEntry && (
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, entryMode: "quantity" })}
                  className={`rounded-xl px-3 py-1.5 text-xs font-medium ${
                    form.entryMode === "quantity" ? "bg-primary text-on-primary" : "bg-background text-muted"
                  }`}
                >
                  مقدار
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, entryMode: "amount" })}
                  className={`rounded-xl px-3 py-1.5 text-xs font-medium ${
                    form.entryMode === "amount" ? "bg-primary text-on-primary" : "bg-background text-muted"
                  }`}
                >
                  مبلغ کل
                </button>
              </div>
            )}

            {showAmountEntry && form.entryMode === "amount" ? (
              <>
                <MoneyInput
                  label="مبلغ کل (تومان)"
                  value={form.totalAmount}
                  onChange={(digits) => setForm({ ...form, totalAmount: digits })}
                />
                <p className="mt-2 text-xs text-muted tabular-fa">
                  {hasValidPurchasePrice
                    ? (() => {
                        const computedGrams = (Number(form.totalAmount) || 0) / Number(form.purchasePricePerUnit);
                        // For gold in milligram mode, the calculator result mirrors
                        // the field it feeds - grams computed here are converted to
                        // milligrams for display, same unit the quantity input
                        // itself is in.
                        const isGoldMilligram = form.type === "gold" && form.quantityUnit === "milligram";
                        const displayQuantity = isGoldMilligram ? computedGrams * 1000 : computedGrams;
                        const unitLabel = isGoldMilligram ? "میلی‌گرم" : getAssetTypeOption(form.type)?.unitLabel;
                        return `= ${formatDecimal(displayQuantity, 6)} ${unitLabel}`;
                      })()
                    : "برای محاسبه، اول قیمت خرید را وارد کنید"}
                </p>
              </>
            ) : (
              <>
                <div className="mt-4 flex items-center justify-between">
                  <label className="block text-xs text-muted">
                    مقدار{" "}
                    {isFormCustom
                      ? ""
                      : `(${
                          form.type === "gold" && form.quantityUnit === "milligram"
                            ? "میلی‌گرم"
                            : getAssetTypeOption(form.type)?.unitLabel
                        })`}
                  </label>
                  {form.type === "gold" && (
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, quantityUnit: "gram" })}
                        className={`rounded-lg px-2 py-0.5 text-xs font-medium ${
                          form.quantityUnit === "gram" ? "bg-primary text-on-primary" : "bg-background text-muted"
                        }`}
                      >
                        گرم
                      </button>
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, quantityUnit: "milligram" })}
                        className={`rounded-lg px-2 py-0.5 text-xs font-medium ${
                          form.quantityUnit === "milligram" ? "bg-primary text-on-primary" : "bg-background text-muted"
                        }`}
                      >
                        میلی‌گرم
                      </button>
                    </div>
                  )}
                </div>
                <input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                  className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
                />
              </>
            )}

            <MoneyInput
              label="قیمت خرید (تومان، به ازای هر واحد)"
              value={form.purchasePricePerUnit}
              onChange={(digits) => setForm({ ...form, purchasePricePerUnit: digits })}
            />
            {liveField &&
              (livePricesLoading ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                  <SpinnerIcon className="h-3 w-3 animate-spin" />
                  در حال دریافت قیمت لحظه‌ای...
                </p>
              ) : typeof livePriceValue === "number" ? (
                purchasePriceNumber === Math.round(livePriceValue) ? (
                  // Already equal to today's price (the auto-prefill, or the
                  // chip below was just tapped) - offering to "use" it again
                  // would be a no-op button.
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                    <CheckIcon className="h-3.5 w-3.5 text-success" />
                    قیمت لحظه‌ای امروز وارد شده است
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={applyLivePrice}
                    className="mt-2 flex items-center gap-1.5 rounded-full bg-accent/15 px-3 py-1.5 text-xs font-medium text-primary-darker"
                  >
                    <RefreshIcon className="h-3.5 w-3.5" />
                    قیمت لحظه‌ای: {formatToman(livePriceValue)} — استفاده شود
                  </button>
                )
              ) : (
                <p className="mt-2 text-xs text-muted">قیمت لحظه‌ای در دسترس نیست؛ قیمت را دستی وارد کنید.</p>
              ))}
            {purchaseTotalPreview !== null && (
              <p className="mt-2 text-xs text-muted">
                مبلغ کل خرید:{" "}
                <span className="font-semibold tabular-fa text-foreground">{formatToman(purchaseTotalPreview)}</span>
              </p>
            )}

            {isFormCustom && (
              <MoneyInput
                label="ارزش فعلی (تومان، به ازای هر واحد)"
                value={form.currentPricePerUnit}
                onChange={(digits) => setForm({ ...form, currentPricePerUnit: digits })}
              />
            )}

            <label className="mt-4 block text-xs text-muted">تاریخ خرید</label>
            <JalaliDatePicker
              value={form.purchaseDate}
              onChange={(purchaseDate) => setForm({ ...form, purchaseDate })}
              maxDate={new Date()}
              showDeadlineCountdown={false}
              quickSelectOptions={PURCHASE_DATE_QUICK_SELECT_OPTIONS}
            />

            <label className="mt-4 block text-xs text-muted">یادداشت (اختیاری)</label>
            <textarea
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              rows={2}
              placeholder="مثلاً محل نگهداری یا کارگزاری"
              className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
            />

            {error && <p className="mt-3 text-xs text-warning">{error}</p>}

            <button
              onClick={handleSave}
              disabled={busy}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary disabled:opacity-50"
            >
              {saving ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
              ذخیره
            </button>

            {form.id !== null &&
              (confirmingDelete ? (
                <div className="mt-3 rounded-2xl border border-warning/30 bg-warning/5 p-3">
                  <p className="text-xs text-foreground">این دارایی برای همیشه حذف شود؟</p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={busy}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-warning py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      {deleting ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <TrashIcon className="h-4 w-4" />}
                      بله، حذف شود
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={busy}
                      className="flex-1 rounded-xl border border-border py-2.5 text-sm text-muted"
                    >
                      انصراف
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={busy}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm font-medium text-warning hover:bg-warning/10 disabled:opacity-50"
                >
                  <TrashIcon className="h-4 w-4" />
                  حذف دارایی
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
