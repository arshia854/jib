"use client";

import { useEffect, useRef, useState } from "react";
import { SectionHeading } from "./section-heading";
import { ChatIcon, SparklesIcon, ChartIcon, CheckIcon } from "@/components/icons";
import { formatNumber, formatToman } from "@/lib/format";

const STEPS = [
  {
    title: "پیامکت رو بفرست",
    description: "یه جمله ساده بنویس یا پیامک بانکت رو کپی‌پیست کن.",
  },
  {
    title: "هوش مصنوعی دسته‌بندی می‌کنه",
    description: "جیب مبلغ، نوع و دسته‌بندی تراکنش رو خودش تشخیص می‌ده.",
  },
  {
    title: "خرجت رو ببین و کنترلش کن",
    description: "با نمودار و گزارش‌های ساده، وضعیت مالیت رو همیشه زیر نظر داشته باش.",
  },
];

// The pinned panel's own mock UI per step - a tiny visual echo of what each
// step's text describes, not a duplicate of PhoneMockup's hero screenshot.
function StepVisual({ step }: { step: number }) {
  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none absolute inset-8 rounded-full bg-primary/20 blur-3xl" />
      <div className="relative rounded-3xl border border-border bg-background p-6 shadow-xl sm:p-8">
        <div aria-hidden className="mb-6 flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-foreground/15" />
          <span className="h-2 w-2 rounded-full bg-foreground/15" />
          <span className="h-2 w-2 rounded-full bg-foreground/15" />
        </div>
        {/* Fixed min-height: the three step visuals differ in height, and on
            mobile this panel sits above the steps (not pinned), so letting it
            resize would shift the page under the user mid-scroll. */}
        <div key={step} className="flex min-h-[8rem] flex-col justify-center animate-slide-up">
          {step === 0 && (
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
                <ChatIcon className="h-4 w-4" />
              </span>
              <div className="rounded-2xl rounded-tr-sm bg-surface px-4 py-3">
                <p className="text-sm leading-relaxed text-foreground">۵۰ تومن ناهار خوردم</p>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
                <SparklesIcon className="h-5 w-5" />
              </span>
              <div className="flex-1 rounded-2xl border border-border bg-surface px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">ناهار 🍔</span>
                  <span className="text-sm font-semibold text-foreground">{formatToman(50000)}</span>
                </div>
                <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                  <CheckIcon className="h-3 w-3" /> خوراک
                </span>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted">گزارش این هفته</span>
                <ChartIcon className="h-4 w-4 text-foreground" />
              </div>
              <div className="mt-3 flex h-16 items-end gap-1.5">
                {[40, 65, 30, 90, 55, 70, 45].map((h, i) => (
                  <div key={i} className="flex-1 rounded-t bg-primary/70" style={{ height: `${h}%` }} />
                ))}
              </div>
              <p className="mt-3 text-xs text-muted">
                مجموع خرج: <span className="font-semibold text-foreground">{formatToman(1950000)}</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function HowItWorksSection() {
  const [active, setActive] = useState(0);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    // IntersectionObserver with a negative-percentage rootMargin (tried
    // first) is unreliable right at the tail end of a short section like
    // this one - step 3 sits right before the section boundary, and its
    // "top crossed into the trigger zone" and "bottom cleared the viewport
    // top" transitions can land in the same or adjacent frames, so the
    // observer can skip reporting it as active at all. A direct
    // getBoundingClientRect() check on every scroll frame is deterministic
    // instead: pick the last step (highest index) whose top has crossed a
    // fixed line near the top of the viewport, recomputed continuously -
    // no rootMargin edge cases, no missed transitions.
    const TRIGGER_RATIO = 0.4; // 40% down the viewport

    function updateActive() {
      const triggerY = window.innerHeight * TRIGGER_RATIO;
      let current = 0;
      for (let i = 0; i < stepRefs.current.length; i++) {
        const el = stepRefs.current[i];
        if (el && el.getBoundingClientRect().top <= triggerY) current = i;
      }
      setActive(current);
    }

    let ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        updateActive();
        ticking = false;
      });
    }

    updateActive();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <section
      id="how-it-works"
      aria-labelledby="how-it-works-title"
      className="scroll-mt-16 bg-surface px-5 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-5xl">
        <SectionHeading
          id="how-it-works-title"
          eyebrow="چطور کار می‌کنه؟"
          title="سه قدم ساده تا کنترل کامل مالی"
          description="نه فرمی، نه جدولی؛ فقط بنویس، بقیه‌ش با جیب."
        />

        <div className="mt-14 grid gap-10 lg:grid-cols-2 lg:gap-16">
          {/* Pinned visual - sticky only from lg up; on smaller screens it
              simply sits above the steps and still reacts as you scroll
              past them, without claiming a pin it can't cleanly hold in a
              short viewport. */}
          <div className="order-1 lg:order-2 lg:sticky lg:top-24 lg:self-start">
            <StepVisual step={active} />
            <div className="mt-5 flex items-center justify-center gap-2">
              {STEPS.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => stepRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  aria-label={`مرحله ${formatNumber(i + 1)}`}
                  aria-current={i === active}
                  className={`h-1.5 rounded-full transition-all ${
                    i === active ? "w-6 bg-primary" : "w-1.5 bg-border"
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="order-2 flex flex-col gap-14 lg:order-1 lg:gap-16 lg:py-16">
            {STEPS.map((step, i) => (
              <div
                key={step.title}
                ref={(el) => {
                  stepRefs.current[i] = el;
                }}
                className={`flex min-h-[22vh] items-start transition-opacity duration-300 lg:min-h-[35vh] lg:items-center ${
                  i === active ? "opacity-100" : "opacity-50"
                }`}
              >
                <div
                  className={`flex w-full items-start gap-4 rounded-2xl p-5 transition-colors duration-300 ${
                    i === active ? "bg-background shadow-sm ring-1 ring-border" : ""
                  }`}
                >
                  <span
                    className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-sm font-bold transition-colors ${
                      i === active ? "bg-primary text-on-primary" : "bg-background text-muted"
                    }`}
                  >
                    {formatNumber(i + 1)}
                  </span>
                  <div>
                    <h3 className="text-lg font-bold text-foreground">{step.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted sm:text-base sm:leading-relaxed">
                      {step.description}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
