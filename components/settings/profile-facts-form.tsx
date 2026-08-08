"use client";

import { useState } from "react";
import { ONBOARDING_FACT_QUESTIONS } from "@/lib/facts/onboarding-questions";
import { SpinnerIcon, CheckIcon } from "@/components/icons";

// Same three questions offered (and skippable) at the end of onboarding
// (app/onboarding/page.tsx) - this is the "بعداً از تنظیمات" landing spot
// for anyone who skipped one there, or wants to change a previous answer.
// Each option saves immediately on click (no separate save button), same
// interaction as the onboarding wizard's option buttons.
export function ProfileFactsForm({ initialValues }: { initialValues: Record<string, string> }) {
  const [values, setValues] = useState(initialValues);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSelect(key: string, value: string) {
    setSavingKey(key);
    setError(null);
    try {
      const res = await fetch("/api/facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ذخیره‌سازی.");
      setValues((prev) => ({ ...prev, [key]: value }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="space-y-6 px-4 pb-8 pt-6">
      <header>
        <h1 className="text-lg font-bold text-foreground">اطلاعات شخصی</h1>
        <p className="mt-1 text-sm text-muted">این اطلاعات کمک می‌کند راهنمایی‌های مالی دقیق‌تری بهت بدهیم.</p>
      </header>

      {ONBOARDING_FACT_QUESTIONS.map((q) => (
        <section key={q.key} className="rounded-2xl border border-border bg-surface p-4">
          <p className="text-sm font-medium text-foreground">{q.question}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {q.options.map((opt) => {
              const selected = values[q.key] === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleSelect(q.key, opt.value)}
                  disabled={savingKey === q.key}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    selected ? "bg-primary-darker text-white" : "border border-border bg-background text-muted"
                  }`}
                >
                  {selected && <CheckIcon className="h-3 w-3" />}
                  {opt.label}
                </button>
              );
            })}
            {savingKey === q.key && <SpinnerIcon className="h-3.5 w-3.5 animate-spin text-muted" />}
          </div>
        </section>
      ))}

      {error && <p className="text-sm text-warning">{error}</p>}
    </div>
  );
}
