"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, EditIcon, TrashIcon, XIcon, CheckIcon, SpinnerIcon, ChartIcon, RefreshIcon } from "@/components/icons";
import { EmptyState } from "@/components/empty-state";
import { ASSET_TYPES, getAssetTypeIcon, getAssetTypeLabel, getAssetTypeOption, type AssetType } from "@/lib/assets";
import { formatToman, formatNumber, formatDecimal } from "@/lib/format";
import { toLatinDigits } from "@/lib/normalize";
import { AssetsHeroCard } from "./assets-hero-card";
import { LivePriceTicker, type TickerEntry } from "./live-price-ticker";
import { QuickPriceCalculator } from "./quick-price-calculator";
import { AssetsProfitLossChart } from "./assets-profit-loss-chart";
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
  purchasePricePerUnit: string;
  purchaseDate: string;
  currentPricePerUnit: string;
  note: string;
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
    purchasePricePerUnit: "",
    purchaseDate: todayInputValue(),
    currentPricePerUnit: "",
    note: "",
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
      <input
        type="text"
        inputMode="numeric"
        value={value ? formatNumber(Number(value)) : ""}
        onChange={(e) => onChange(toLatinDigits(e.target.value).replace(/[^0-9]/g, ""))}
        className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
      />
    </>
  );
}

// Builds LivePriceTicker/QuickPriceCalculator's shared entries: one tile per
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
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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
    setForm((f) => (f ? { ...f, type } : f));
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
      purchasePricePerUnit: String(asset.purchasePricePerUnit),
      purchaseDate: toInputDate(asset.purchaseDate),
      currentPricePerUnit: asset.currentPricePerUnit !== null ? String(asset.currentPricePerUnit) : "",
      note: asset.note ?? "",
    });
    setError(null);
  }

  async function handleSave() {
    if (!form) return;
    const isCustom = form.type === "custom";

    if (isCustom && !form.name.trim()) {
      setError("برای دارایی دستی، نام الزامی است.");
      return;
    }
    const quantity = Number(form.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError("مقدار دارایی نامعتبر است.");
      return;
    }
    const purchasePricePerUnit = Number(form.purchasePricePerUnit);
    if (!Number.isFinite(purchasePricePerUnit) || purchasePricePerUnit <= 0) {
      setError("قیمت خرید نامعتبر است.");
      return;
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

  async function handleDelete(id: number) {
    setDeletingId(id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/assets/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در حذف.");
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setDeletingId(null);
    }
  }

  const isFormCustom = form?.type === "custom";
  // Only offered on a *new* asset of a live-priced type - see the prefill
  // effect above for why edit is excluded.
  const liveField = form && form.id === null ? LIVE_PRICE_FIELD[form.type] : undefined;
  const livePriceValue = liveField && livePrices && !livePrices.unavailable ? livePrices[liveField] : undefined;

  return (
    <div className="space-y-6 px-4 pb-8 pt-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-foreground">دارایی‌ها</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary shadow-sm shadow-primary/20 transition-transform active:scale-95"
        >
          <PlusIcon className="h-4 w-4" />
          افزودن دارایی
        </button>
      </header>

      <AssetsHeroCard
        totalValue={summary.totalValue}
        totalCostBasis={summary.totalCostBasis}
        totalProfitLossToman={summary.totalProfitLossToman}
        totalProfitLossPercent={summary.totalProfitLossPercent}
      />

      {summary.priceUnavailable && (
        <p className="rounded-xl bg-warning/10 p-3 text-xs text-warning">
          قیمت لحظه‌ای طلا/دلار/بیت‌کوین در دسترس نیست؛ سود و زیان این دارایی‌ها موقتاً قابل محاسبه نیست.
        </p>
      )}
      {!summary.priceUnavailable && summary.priceStale && (
        <p className="rounded-xl bg-background p-3 text-xs text-muted">قیمت‌ها ممکن است کاملاً به‌روز نباشند.</p>
      )}
      {deleteError && <p className="rounded-xl bg-warning/10 p-3 text-xs text-warning">{deleteError}</p>}

      <LivePriceTicker entries={tickerEntries} />
      <QuickPriceCalculator entries={tickerEntries} />

      {summary.assets.length === 0 ? (
        <EmptyState
          icon={<ChartIcon className="h-6 w-6" />}
          title="هنوز دارایی‌ای ثبت نکرده‌اید"
          description="با دکمه «افزودن دارایی» بالا، طلا، دلار، بیت‌کوین یا هر دارایی دیگری که دارید را اضافه کنید تا سود و زیانش را دنبال کنید."
        />
      ) : (
        <>
          <AssetsProfitLossChart assets={summary.assets} />
          <div className="rounded-2xl border border-border bg-surface px-4">
          {summary.assets.map((asset, i) => {
            const option = getAssetTypeOption(asset.type);
            return (
              <div key={asset.id} className={`py-3 ${i > 0 ? "border-t border-border" : ""}`}>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-background text-base">
                    {getAssetTypeIcon(asset.type)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {asset.type === "custom" ? asset.name : getAssetTypeLabel(asset.type)}
                    </p>
                    <p className="text-xs text-muted tabular-fa">
                      {formatDecimal(asset.quantity, 6)} {option?.unitLabel}
                    </p>
                  </div>
                  <button
                    onClick={() => openEdit(asset)}
                    aria-label="ویرایش"
                    className="shrink-0 rounded-full p-2 text-muted hover:bg-background hover:text-accent"
                  >
                    <EditIcon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(asset.id)}
                    disabled={deletingId === asset.id}
                    aria-label="حذف"
                    className="shrink-0 rounded-full p-2 text-muted hover:bg-background hover:text-warning disabled:opacity-50"
                  >
                    {deletingId === asset.id ? (
                      <SpinnerIcon className="h-4 w-4 animate-spin" />
                    ) : (
                      <TrashIcon className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between pr-[52px]">
                  <span className="text-xs text-muted">ارزش فعلی</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold tabular-fa text-foreground">
                      {asset.currentValue !== null ? formatToman(asset.currentValue) : "—"}
                    </span>
                    {asset.profitLossToman !== null && asset.profitLossPercent !== null && (
                      <ProfitLossBadge toman={asset.profitLossToman} percent={asset.profitLossPercent} />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          </div>
        </>
      )}

      {form && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => !saving && setForm(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface p-5 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-foreground">{form.id ? "ویرایش دارایی" : "دارایی جدید"}</h2>
              <button onClick={() => setForm(null)} disabled={saving} aria-label="بستن">
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

            <label className="mt-4 block text-xs text-muted">
              مقدار {isFormCustom ? "" : `(${getAssetTypeOption(form.type)?.unitLabel})`}
            </label>
            <input
              type="number"
              step="any"
              inputMode="decimal"
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
            />

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
                <button
                  type="button"
                  onClick={applyLivePrice}
                  className="mt-2 flex items-center gap-1.5 rounded-full bg-accent/15 px-3 py-1.5 text-xs font-medium text-primary-darker"
                >
                  <RefreshIcon className="h-3.5 w-3.5" />
                  قیمت لحظه‌ای: {formatToman(livePriceValue)} — استفاده شود
                </button>
              ) : (
                <p className="mt-2 text-xs text-muted">قیمت لحظه‌ای در دسترس نیست؛ قیمت را دستی وارد کنید.</p>
              ))}

            {isFormCustom && (
              <MoneyInput
                label="ارزش فعلی (تومان، به ازای هر واحد)"
                value={form.currentPricePerUnit}
                onChange={(digits) => setForm({ ...form, currentPricePerUnit: digits })}
              />
            )}

            <label className="mt-4 block text-xs text-muted">تاریخ خرید</label>
            <input
              type="date"
              value={form.purchaseDate}
              onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })}
              className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
            />

            <label className="mt-4 block text-xs text-muted">یادداشت (اختیاری)</label>
            <textarea
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              rows={2}
              className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
            />

            {error && <p className="mt-3 text-xs text-warning">{error}</p>}

            <button
              onClick={handleSave}
              disabled={saving}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary disabled:opacity-50"
            >
              {saving ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
              ذخیره
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
