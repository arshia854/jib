import Link from "next/link";
import { PhoneMockup } from "./phone-mockup";
import { Reveal } from "./reveal";

export function HeroSection() {
  return (
    <section className="relative overflow-hidden px-5 pb-16 pt-12 sm:pt-20">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-accent/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 end-0 h-72 w-72 rounded-full bg-primary/10 blur-3xl"
      />

      <div className="relative mx-auto flex max-w-6xl flex-col items-center gap-10 sm:gap-14 lg:flex-row lg:items-center lg:justify-between lg:gap-20">
        <div className="max-w-xl text-center lg:text-start">
          <Reveal>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-accent">
              <span aria-hidden>✨</span> دستیار مالی هوشمند فارسی
            </span>
          </Reveal>
          <Reveal delay={100}>
            <h1 className="mt-5 text-3xl font-bold leading-[1.3] text-foreground sm:text-4xl lg:text-5xl">
              خرجت رو با یک جمله ثبت کن،
              <br />
              بقیه‌ش با جیب
            </h1>
          </Reveal>
          <Reveal delay={200}>
            <p className="mt-5 text-base leading-relaxed text-muted sm:text-lg">
              کافیه بنویسی «۵۰ تومن ناهار خوردم» یا پیامک بانکت رو بفرستی؛ هوش مصنوعی جیب خودش
              مبلغ و دسته‌بندیش رو تشخیص می‌ده و برات ثبت می‌کنه.
            </p>
          </Reveal>
          <Reveal delay={300}>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row lg:justify-start">
              <Link
                href="/login"
                className="w-full rounded-2xl bg-primary px-8 py-3.5 text-center text-sm font-semibold text-white shadow-lg shadow-primary/25 transition-transform active:scale-95 sm:w-auto"
              >
                رایگان امتحان کن
              </Link>
              <a
                href="#how-it-works"
                className="w-full rounded-2xl border border-border px-8 py-3.5 text-center text-sm font-semibold text-foreground transition-colors hover:bg-surface sm:w-auto"
              >
                چطور کار می‌کنه؟
              </a>
            </div>
          </Reveal>
        </div>

        <Reveal delay={150} className="w-full max-w-sm lg:max-w-md">
          <PhoneMockup />
        </Reveal>
      </div>
    </section>
  );
}
