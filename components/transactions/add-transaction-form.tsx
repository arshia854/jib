"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, XIcon, SparklesIcon, SpinnerIcon } from "@/components/icons";
import { formatToman, formatJalaaliDate } from "@/lib/format";
import type { CategoryType } from "@/lib/categories";

interface CategoryOption {
  id: number;
  name: string;
  icon: string;
  color: string;
  type: string;
}

interface ParsedResult {
  amount: number;
  type: CategoryType;
  category: string;
  description: string;
  date: string;
}

type Stage = "input" | "loading" | "preview" | "saving";

export function AddTransactionForm({ categories }: { categories: CategoryOption[] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [stage, setStage] = useState<Stage>("input");
  const [parsed, setParsed] = useState<ParsedResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = stage === "loading" || stage === "saving";

  async function handleParse() {
    if (!text.trim()) return;
    setStage("loading");
    setError(null);
    try {
      const res = await fetch("/api/transactions/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در پردازش متن.");
      setParsed(data.parsed);
      setStage("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setStage("input");
    }
  }

  async function handleConfirm() {
    if (!parsed) return;
    setStage("saving");
    setError(null);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parsed, rawInput: text.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ذخیره تراکنش.");
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setStage("preview");
    }
  }

  function handleReset() {
    setParsed(null);
    setError(null);
    setStage("input");
  }

  const availableCategories = categories.filter((c) => c.type === parsed?.type);

  return (
    <div className="flex h-full flex-col px-4 pb-6 pt-6">
      <h1 className="text-lg font-bold text-foreground">افزودن تراکنش</h1>
      <p className="mt-1 text-sm text-muted">
        تراکنش را به زبان طبیعی بنویس، هوش مصنوعی جزئیات را استخراج می‌کند.
      </p>

      {stage === "input" || stage === "loading" ? (
        <div className="mt-6 flex flex-col gap-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="مثلاً: ۵۰ هزار تومن ناهار خوردم"
            rows={4}
            className="w-full resize-none rounded-2xl border border-border bg-surface p-4 text-sm text-foreground outline-none focus:border-accent"
            disabled={stage === "loading"}
          />
          {error && <p className="text-sm text-warning">{error}</p>}
          <button
            onClick={handleParse}
            disabled={busy || !text.trim()}
            className="flex items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
          >
            {stage === "loading" ? (
              <>
                <SpinnerIcon className="h-4 w-4 animate-spin" />
                در حال پردازش...
              </>
            ) : (
              <>
                <SparklesIcon className="h-4 w-4" />
                بررسی با هوش مصنوعی
              </>
            )}
          </button>
        </div>
      ) : (
        parsed && (
          <div className="mt-6 flex flex-col gap-4">
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="text-xs text-muted">پیش‌نمایش تراکنش</p>

              <div className="mt-3 flex gap-2">
                {(["expense", "income"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      setParsed({
                        ...parsed,
                        type: t,
                        category: categories.find((c) => c.type === t)?.name ?? parsed.category,
                      })
                    }
                    className={`flex-1 rounded-xl py-2 text-sm font-medium transition-colors ${
                      parsed.type === t
                        ? t === "income"
                          ? "bg-success text-white"
                          : "bg-warning text-white"
                        : "bg-background text-muted"
                    }`}
                  >
                    {t === "income" ? "درآمد" : "هزینه"}
                  </button>
                ))}
              </div>

              <label className="mt-4 block text-xs text-muted">مبلغ (تومان)</label>
              <input
                type="number"
                value={parsed.amount}
                onChange={(e) => setParsed({ ...parsed, amount: Number(e.target.value) })}
                className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
              />

              <label className="mt-4 block text-xs text-muted">دسته‌بندی</label>
              <select
                value={parsed.category}
                onChange={(e) => setParsed({ ...parsed, category: e.target.value })}
                className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
              >
                {availableCategories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.icon} {c.name}
                  </option>
                ))}
              </select>

              <label className="mt-4 block text-xs text-muted">توضیح</label>
              <input
                type="text"
                value={parsed.description}
                onChange={(e) => setParsed({ ...parsed, description: e.target.value })}
                className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
              />

              <label className="mt-4 block text-xs text-muted">
                تاریخ ({formatJalaaliDate(parsed.date)})
              </label>
              <input
                type="date"
                value={parsed.date}
                onChange={(e) => setParsed({ ...parsed, date: e.target.value })}
                className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
              />

              <div className="mt-4 rounded-xl bg-background p-3 text-center">
                <p className="text-xs text-muted">مبلغ نهایی</p>
                <p
                  className={`text-xl font-bold tabular-fa ${
                    parsed.type === "income" ? "text-success" : "text-warning"
                  }`}
                >
                  {formatToman(parsed.amount)}
                </p>
              </div>
            </div>

            {error && <p className="text-sm text-warning">{error}</p>}

            <div className="flex gap-3">
              <button
                onClick={handleReset}
                disabled={stage === "saving"}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-border py-3.5 text-sm font-semibold text-foreground disabled:opacity-50"
              >
                <XIcon className="h-4 w-4" />
                ویرایش متن
              </button>
              <button
                onClick={handleConfirm}
                disabled={stage === "saving"}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {stage === "saving" ? (
                  <SpinnerIcon className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckIcon className="h-4 w-4" />
                )}
                تأیید و ذخیره
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
