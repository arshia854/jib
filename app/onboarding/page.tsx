"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SpinnerIcon, CheckIcon } from "@/components/icons";
import { ONBOARDING_FACT_QUESTIONS } from "@/lib/facts/onboarding-questions";
import { formatNumber } from "@/lib/format";

// -1 = the name/age form below; 0..N-1 = one ONBOARDING_FACT_QUESTIONS step
// at a time; reaching N means every step was answered or skipped, and
// finishOnboarding() below fires immediately instead of ever rendering a
// step N.
const BASICS_STEP = -1;

// Same soft, blurred brand-color glow used behind the marketing landing
// page's hero (components/landing/hero-section.tsx) - reused here so the
// onboarding flow reads as a continuation of the same product instead of
// dropping into a plainer "form" mode. Must be a sibling of the centered
// content column (not a wrapper around it) inside a `relative overflow-hidden`
// parent, same as the hero.
function OnboardingGlow() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-accent/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 end-0 h-64 w-64 rounded-full bg-primary/10 blur-3xl"
      />
    </>
  );
}

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
    const total = ONBOARDING_FACT_QUESTIONS.length;
    return (
      <div className="relative flex min-h-dvh flex-col justify-center overflow-hidden px-6 py-10">
        <OnboardingGlow />
        {/* Keyed by step so each new question mounts fresh and replays the
            slide-up entrance (same @keyframes as the PWA install prompt,
            see globals.css) instead of the copy just snapping to new text. */}
        <div key={step} className="animate-slide-up relative mx-auto w-full max-w-sm">
          <div
            className="mb-6 flex items-center justify-center gap-1.5"
            role="progressbar"
            aria-valuenow={step + 1}
            aria-valuemin={1}
            aria-valuemax={total}
            aria-label={`قدم ${step + 1} از ${total}`}
          >
            {ONBOARDING_FACT_QUESTIONS.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i <= step ? "w-8 bg-primary" : "w-4 bg-border"
                }`}
              />
            ))}
          </div>

          <div className="mb-8 text-center">
            <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-subtle text-2xl shadow-sm shadow-primary/10">
              {question.emoji}
            </span>
            <p className="text-xs font-medium text-muted">
              قدم {formatNumber(step + 1)} از {formatNumber(total)}
            </p>
            <h1 className="mt-1.5 text-2xl font-bold leading-snug text-foreground">{question.question}</h1>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {question.options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={savingFact}
                onClick={() => handleAnswer(question.key, opt.value)}
                className="group flex flex-col items-center gap-2 rounded-2xl border-2 border-border bg-surface px-4 py-5 text-center transition-all duration-150 last:odd:col-span-2 hover:border-primary hover:bg-primary-bg hover:shadow-lg hover:shadow-primary/10 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100"
              >
                <span className="text-3xl transition-transform duration-150 group-hover:scale-110">{opt.emoji}</span>
                <span className="text-sm font-semibold text-foreground">{opt.label}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={advance}
            disabled={savingFact}
            className="mt-8 flex w-full items-center justify-center gap-2 rounded-full py-2 text-xs text-muted transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50"
          >
            {savingFact && <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
            فعلاً رد کن — بعداً از تنظیمات می‌تونی وارد کنی
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-dvh flex-col justify-center overflow-hidden px-6 py-10">
      <OnboardingGlow />
      <div className="relative mx-auto w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-subtle text-2xl shadow-sm shadow-primary/10">
            👋
          </span>
          <h1 className="text-2xl font-bold text-foreground">چند قدم مونده</h1>
          <p className="mt-2 text-sm text-muted">برای شخصی‌سازی جیبو، کمی درباره خودت بگو</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="mb-1.5 block text-xs text-muted">اسم</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثلاً ارشیا"
              maxLength={60}
              className="w-full rounded-2xl border border-border bg-surface p-4 text-sm text-foreground outline-none transition-colors focus:border-accent"
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
              className="w-full rounded-2xl border border-border bg-surface p-4 text-center text-sm text-foreground outline-none transition-colors focus:border-accent"
            />
          </div>

          {error && <p className="text-center text-sm text-warning">{error}</p>}

          <button
            type="submit"
            disabled={loading || !name.trim() || !age}
            className="mt-2 flex items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition-transform active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
          >
            {loading ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
            بزن بریم
          </button>
        </form>
      </div>
    </div>
  );
}
