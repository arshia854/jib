"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, XIcon, SpinnerIcon, ChatIcon } from "@/components/icons";
import { formatToman, formatNumber, formatJalaaliDate } from "@/lib/format";
import { toLatinDigits } from "@/lib/normalize";
import type { ParsedTransaction } from "@/lib/ai/parse-transaction";
import { getBankLabel } from "@/lib/bank/labels";
import { getAccountTypeIcon } from "@/lib/accounts";

interface CategoryOption {
  id: number;
  name: string;
  icon: string;
  color: string;
  type: string;
}

interface AccountOption {
  id: number;
  name: string;
  type: string;
}

interface EditTransaction extends Pick<ParsedTransaction, "amount" | "type" | "category" | "description" | "date"> {
  id: number;
  accountId: number;
}

type Stage = "input" | "preview" | "saving";

const PARSE_RATE_LIMIT_MESSAGE =
  "پیش‌نمایش خودکار به‌دلیل تعداد زیاد درخواست موقتاً متوقف شد؛ کمی صبر کن، خودش دوباره فعال می‌شود.";

export function AddTransactionForm({
  categories,
  accounts,
  defaultAccountId,
  editTransaction,
}: {
  categories: CategoryOption[];
  accounts: AccountOption[];
  defaultAccountId: number;
  editTransaction?: EditTransaction;
}) {
  const router = useRouter();
  const isEdit = Boolean(editTransaction);
  const [text, setText] = useState("");
  const [stage, setStage] = useState<Stage>(editTransaction ? "preview" : "input");
  const [parsed, setParsed] = useState<ParsedTransaction | null>(editTransaction ?? null);
  const [accountId, setAccountId] = useState<number>(editTransaction?.accountId ?? defaultAccountId);
  const [error, setError] = useState<string | null>(null);
  const [livePreview, setLivePreview] = useState<ParsedTransaction | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseLimitedUntil, setParseLimitedUntil] = useState<number | null>(null);
  const [liveCategoryExpanded, setLiveCategoryExpanded] = useState(false);

  // Auto-parses in the background while the user is still typing in the
  // "input" stage, so a lightweight preview can appear without a button
  // press. Debounced so we don't hit the API on every keystroke, and
  // aborted on the next keystroke/unmount so a slow stale response can't
  // overwrite a newer one.
  //
  // While parseLimitedUntil is in the future (server returned 429), this
  // skips scheduling entirely instead of retrying on every keystroke - the
  // companion effect below clears it once the window resets, which
  // re-triggers this effect and resumes auto-parsing on its own.
  useEffect(() => {
    if (stage !== "input") return;
    const trimmed = text.trim();
    if (trimmed.length < 4) return;
    if (parseLimitedUntil && Date.now() < parseLimitedUntil) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setIsParsing(true);
      try {
        const res = await fetch("/api/transactions/parse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed }),
          signal: controller.signal,
        });

        if (res.status === 429) {
          const data = await res.json().catch(() => ({}));
          const retryAfterSeconds =
            typeof data.retryAfterSeconds === "number" && data.retryAfterSeconds > 0 ? data.retryAfterSeconds : 60;
          setParseLimitedUntil(Date.now() + retryAfterSeconds * 1000);
          setLiveError(PARSE_RATE_LIMIT_MESSAGE);
          setLivePreview(null);
          return;
        }

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "خطا در پردازش متن.");
        setLivePreview(data.parsed);
        setLiveError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLiveError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
        setLivePreview(null);
      } finally {
        setIsParsing(false);
      }
    }, 700);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, stage, parseLimitedUntil]);

  // Resumes auto-parsing once the rate-limit window reported by the server
  // has elapsed, without requiring another keystroke.
  useEffect(() => {
    if (!parseLimitedUntil) return;
    const ms = Math.max(parseLimitedUntil - Date.now(), 0);
    const timer = setTimeout(() => setParseLimitedUntil(null), ms);
    return () => clearTimeout(timer);
  }, [parseLimitedUntil]);

  // Shared by the full preview stage's confirm button and the inline
  // live-preview card's direct submit button - both promote a
  // ParsedTransaction into `parsed` and save it the same way. Takes the
  // transaction explicitly rather than reading `parsed` from state so the
  // live-preview path can call this in the same tick as setParsed() without
  // racing React's async state update.
  async function saveTransaction(transaction: ParsedTransaction) {
    setStage("saving");
    setError(null);
    try {
      const res = isEdit
        ? await fetch(`/api/transactions/${editTransaction!.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              amount: transaction.amount,
              type: transaction.type,
              category: transaction.category,
              description: transaction.description,
              date: transaction.date,
              accountId,
            }),
          })
        : await fetch("/api/transactions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...transaction, rawInput: text.trim(), accountId }),
          });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || (isEdit ? "خطا در ذخیره تغییرات." : "خطا در ذخیره تراکنش."));
      router.push(isEdit ? "/app/transactions" : "/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setStage("preview");
    }
  }

  function handleConfirm() {
    if (!parsed) return;
    saveTransaction(parsed);
  }

  function handleSubmitLivePreview() {
    if (!livePreview) return;
    setParsed(livePreview);
    saveTransaction(livePreview);
  }

  function handleDismissLivePreview() {
    setText("");
    setLivePreview(null);
    setLiveError(null);
    setLiveCategoryExpanded(false);
  }

  function handleReset() {
    setParsed(null);
    setError(null);
    setStage("input");
  }

  const availableCategories = categories.filter((c) => c.type === parsed?.type);
  const showLiveResult = text.trim().length >= 4;

  return (
    <div className="flex h-full flex-col px-4 pb-6 pt-6">
      <h1 className="text-lg font-bold text-foreground">{isEdit ? "ویرایش تراکنش" : "افزودن تراکنش"}</h1>
      <p className="mt-1 text-sm text-muted">
        {isEdit
          ? "جزئیات تراکنش را ویرایش کن و ذخیره کن."
          : "تراکنش را به زبان طبیعی بنویس، هوش مصنوعی جزئیات را استخراج می‌کند."}
      </p>

      {stage === "input" ? (
        <div className="mt-6 flex flex-col gap-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="مثلاً: ۵۰ هزار تومن ناهار خوردم"
            rows={4}
            className="w-full resize-none rounded-2xl border border-border bg-surface p-4 text-sm text-foreground outline-none focus:border-accent"
          />
          {showLiveResult && isParsing && !livePreview && !liveError && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
              در حال پردازش...
            </p>
          )}
          {showLiveResult &&
            livePreview &&
            (() => {
              const liveCategories = categories.filter((c) => c.type === livePreview.type);
              return (
                <div className="rounded-2xl border border-border bg-surface p-4">
                  <p className="text-xs text-muted">پیش‌نمایش هوش مصنوعی — قابل ویرایش</p>

                  <div className="mt-2 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={handleDismissLivePreview}
                      aria-label="بستن"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background text-muted transition-colors hover:text-foreground"
                    >
                      <XIcon className="h-4 w-4" />
                    </button>
                    <p className="truncate text-sm font-semibold text-foreground">
                      {livePreview.description} {formatToman(livePreview.amount)}
                    </p>
                  </div>

                  <div className="mt-3 flex gap-2">
                    {(["expense", "income"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() =>
                          setLivePreview({
                            ...livePreview,
                            type: t,
                            category: categories.find((c) => c.type === t)?.name ?? livePreview.category,
                          })
                        }
                        className={`flex-1 rounded-xl py-2 text-sm font-medium transition-colors ${
                          livePreview.type === t ? "bg-primary-darker text-white" : "bg-background text-muted"
                        }`}
                      >
                        {t === "income" ? "درآمد" : "هزینه"}
                      </button>
                    ))}
                  </div>

                  <label className="mt-4 block text-xs text-muted">مبلغ (تومان)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={formatNumber(livePreview.amount)}
                    onChange={(e) => {
                      const digits = toLatinDigits(e.target.value).replace(/[^0-9]/g, "");
                      setLivePreview({ ...livePreview, amount: digits ? Number(digits) : 0 });
                    }}
                    className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
                  />

                  <label className="mt-4 block text-xs text-muted">دسته‌بندی</label>
                  {liveCategoryExpanded ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {liveCategories.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setLivePreview({ ...livePreview, category: c.name })}
                          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                            livePreview.category === c.name
                              ? "bg-primary-darker text-white"
                              : "border border-border bg-background text-muted"
                          }`}
                        >
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                          {c.name}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setLiveCategoryExpanded(false)}
                        className="text-xs text-accent"
                      >
                        بستن
                      </button>
                    </div>
                  ) : (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {(() => {
                        const selectedCategory = liveCategories.find((c) => c.name === livePreview.category);
                        if (!selectedCategory) return null;
                        return (
                          <span className="flex items-center gap-1.5 rounded-full bg-primary-darker px-3 py-1.5 text-xs font-medium text-white">
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: selectedCategory.color }}
                            />
                            {selectedCategory.name}
                          </span>
                        );
                      })()}
                      <button
                        type="button"
                        onClick={() => setLiveCategoryExpanded(true)}
                        className="text-xs text-accent"
                      >
                        بیشتر
                      </button>
                    </div>
                  )}

                  {/* Saving/error state surfaces via the full preview stage below - saveTransaction()
                      moves `stage` off "input" in the same batch as this click, so this card
                      unmounts before any loading state of its own would be visible. */}
                  <button
                    type="button"
                    onClick={handleSubmitLivePreview}
                    className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary-darker py-3.5 text-sm font-semibold text-white"
                  >
                    ثبت تراکنش
                  </button>
                </div>
              );
            })()}
          {showLiveResult && liveError && <p className="text-xs text-warning">{liveError}</p>}
          {error && <p className="text-sm text-warning">{error}</p>}
        </div>
      ) : (
        parsed && (
          <div className="mt-6 flex flex-col gap-4">
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="text-xs text-muted">پیش‌نمایش تراکنش</p>

              {parsed.source === "bank-sms" && parsed.bank && parsed.bank !== "unknown" && (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent">
                  <ChatIcon className="h-3.5 w-3.5" />
                  پیامک بانکی · {getBankLabel(parsed.bank)}
                </div>
              )}

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
                className={`mt-1 w-full rounded-xl border bg-background p-3 text-sm outline-none focus:border-accent ${
                  parsed.source === "bank-sms" ? "border-warning" : "border-border"
                }`}
              >
                {availableCategories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.icon} {c.name}
                  </option>
                ))}
              </select>
              {parsed.needsConfirmation && (
                <p className="mt-1.5 text-xs text-warning">
                  {parsed.source === "bank-sms"
                    ? "دسته‌بندی از پیامک بانکی قابل تشخیص نبود، لطفاً انتخاب کنید"
                    : "دسته‌بندی پیشنهادی است، لطفاً بررسی کنید"}
                </p>
              )}

              <label className="mt-4 block text-xs text-muted">حساب</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(Number(e.target.value))}
                className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {getAccountTypeIcon(a.type)} {a.name}
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
                onClick={isEdit ? () => router.push("/app/transactions") : handleReset}
                disabled={stage === "saving"}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-border py-3.5 text-sm font-semibold text-foreground disabled:opacity-50"
              >
                <XIcon className="h-4 w-4" />
                {isEdit ? "انصراف" : "ویرایش متن"}
              </button>
              <button
                onClick={handleConfirm}
                disabled={stage === "saving"}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-primary-darker py-3.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {stage === "saving" ? (
                  <SpinnerIcon className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckIcon className="h-4 w-4" />
                )}
                {isEdit ? "ذخیره تغییرات" : "تأیید و ذخیره"}
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
