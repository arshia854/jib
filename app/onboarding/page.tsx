"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SpinnerIcon, CheckIcon } from "@/components/icons";
import { ONBOARDING_FACT_QUESTIONS } from "@/lib/facts/onboarding-questions";

// -1 = the name/age form below; 0..N-1 = one ONBOARDING_FACT_QUESTIONS step
// at a time; reaching N means every step was answered or skipped, and
// finishOnboarding() below fires immediately instead of ever rendering a
// step N.
const BASICS_STEP = -1;

export default function OnboardingPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(BASICS_STEP);
  const [savingFact, setSavingFact] = useState(false);

  function finishOnboarding() {
    router.push("/app");
    router.refresh();
  }

  // Shared by both the "pick an option" and "رد کن" paths below - either
  // way the wizard moves on, the only difference is whether a fetch to
  // /api/facts happens first. Best-effort: these facts are all optional
  // (skippable here, and re-answerable later from Settings - see
  // components/settings/profile-facts-form.tsx), so a network hiccup while
  // saving one must never block the user from finishing onboarding.
  function advance() {
    setStep((current) => {
      const next = current + 1;
      if (next >= ONBOARDING_FACT_QUESTIONS.length) {
        finishOnboarding();
        return current;
      }
      return next;
    });
  }

  async function handleAnswer(key: string, value: string) {
    setSavingFact(true);
    try {
      await fetch("/api/facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    } catch {
      // Ignored on purpose - see advance()'s doc comment above.
    } finally {
      setSavingFact(false);
      advance();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, age: Number(age) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ذخیره اطلاعات.");
      // Onboarding itself (name/age + default category/account seeding) is
      // already done and committed at this point - what follows is a few
      // optional, skippable personalization questions, not a continuation
      // of the same required step.
      advance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setLoading(false);
    }
  }

  if (step >= 0) {
    const question = ONBOARDING_FACT_QUESTIONS[step];
    return (
      <div className="flex min-h-dvh flex-col justify-center px-6 py-10">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 text-center">
            <p className="text-xs text-muted">
              {step + 1} از {ONBOARDING_FACT_QUESTIONS.length}
            </p>
            <h1 className="mt-2 text-xl font-bold text-foreground">{question.question}</h1>
          </div>

          <div className="flex flex-wrap justify-center gap-2">
            {question.options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={savingFact}
                onClick={() => handleAnswer(question.key, opt.value)}
                className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm font-medium text-foreground transition-colors hover:border-accent disabled:opacity-50"
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={advance}
            disabled={savingFact}
            className="mt-8 flex w-full items-center justify-center gap-2 text-xs text-muted disabled:opacity-50"
          >
            {savingFact && <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
            فعلاً رد کن — بعداً از تنظیمات می‌تونی وارد کنی
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center px-6 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-foreground">چند قدم مونده</h1>
          <p className="mt-2 text-sm text-muted">برای شخصی‌سازی جیب، کمی درباره خودت بگو</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="mb-1.5 block text-xs text-muted">اسم</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثلاً آرشیا"
              maxLength={60}
              className="w-full rounded-2xl border border-border bg-surface p-4 text-sm text-foreground outline-none focus:border-accent"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-muted">سن</label>
            <input
              type="number"
              inputMode="numeric"
              dir="ltr"
              value={age}
              onChange={(e) => setAge(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
              placeholder="۲۵"
              className="w-full rounded-2xl border border-border bg-surface p-4 text-center text-sm text-foreground outline-none focus:border-accent"
            />
          </div>

          {error && <p className="text-center text-sm text-warning">{error}</p>}

          <button
            type="submit"
            disabled={loading || !name.trim() || !age}
            className="mt-2 flex items-center justify-center gap-2 rounded-2xl bg-primary-darker py-3.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {loading ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
            بزن بریم
          </button>
        </form>
      </div>
    </div>
  );
}
