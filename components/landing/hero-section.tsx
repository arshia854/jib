import Link from "next/link";
import { PhoneMockup } from "./phone-mockup";
import { Reveal } from "./reveal";
import { BackIcon, CheckIcon, SparklesIcon } from "@/components/icons";

// Each point restates something already promised elsewhere on this page
// (final-cta-section.tsx's "no bank card, under a minute") - not new claims.
const HERO_POINTS = ["بدون نیاز به کارت بانکی", "شروع در کمتر از یک دقیقه", "کاملاً فارسی، با تاریخ شمسی"];

export function HeroSection() {
  return (
    <section className="relative overflow-hidden px-5 pb-20 pt-14 sm:pb-28 sm:pt-24">
      <div
        aria-hidden
        className="landing-grid pointer-events-none absolute inset-0 mask-radial-at-top mask-radial-from-20% mask-radial-to-75%"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-accent/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 end-0 h-72 w-72 rounded-full bg-primary/10 blur-3xl"
      />

      <div className="relative mx-auto flex max-w-6xl flex-col items-center gap-14 lg:flex-row lg:items-center lg:justify-between lg:gap-20">
        <div className="max-w-xl text-center lg:text-start">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/80 py-1 pe-3.5 ps-1 text-xs font-medium text-foreground backdrop-blur">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-on-primary">
                <SparklesIcon className="h-3 w-3" />
              </span>
              دستیار مالی هوشمند فارسی
            </span>
          </Reveal>
          <Reveal delay={100}>
            {/* lg:text-4xl → xl:text-5xl: the mockup column narrows the text
                column at lg, where 5xl wrapped the first line. "ثبت کن،" stays
                together so a wrap on very narrow phones (~360px) breaks at
                the phrase, not mid-verb. */}
            <h1 className="mt-6 text-3xl font-extrabold leading-[1.4] text-foreground sm:text-4xl xl:text-5xl xl:leading-[1.35]">
              خرجت رو با یک جمله <span className="whitespace-nowrap">ثبت کن،</span>
              <br />
              <span className="bg-gradient-to-t from-primary/50 from-25% to-transparent to-25% px-1 [box-decoration-break:clone]">
                بقیه‌ش با جیب
              </span>
            </h1>
          </Reveal>
          <Reveal delay={200}>
            <p className="mx-auto mt-6 max-w-lg text-base leading-loose text-muted sm:text-lg sm:leading-loose lg:mx-0">
              کافیه بنویسی «۵۰ تومن ناهار خوردم» یا پیامک بانکت رو بفرستی؛ هوش مصنوعی جیب خودش
              مبلغ و دسته‌بندیش رو تشخیص می‌ده و برات ثبت می‌کنه.
            </p>
          </Reveal>
          <Reveal delay={300}>
            <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <Link
                href="/login"
                className="group inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-bold text-on-primary shadow-lg shadow-primary/25 transition-transform active:scale-95 sm:w-auto"
              >
                رایگان امتحان کن
                {/* Bare BackIcon points toward the reading end (left in RTL) -
                    same "forward" convention as goals/jalali-date-picker.tsx's month nav. */}
                <BackIcon className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
              </Link>
              <a
                href="#how-it-works"
                className="w-full rounded-2xl border border-border bg-background/60 px-8 py-4 text-center text-sm font-semibold text-foreground transition-colors hover:bg-surface sm:w-auto"
              >
                چطور کار می‌کنه؟
              </a>
            </div>
          </Reveal>
          <Reveal delay={400}>
            <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2.5 text-xs text-muted sm:text-sm lg:justify-start">
              {HERO_POINTS.map((point) => (
                <li key={point} className="flex items-center gap-1.5">
                  <CheckIcon className="h-4 w-4 shrink-0 text-success" />
                  {point}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>

        <Reveal delay={150} className="w-full max-w-sm lg:max-w-md">
          <PhoneMockup />
        </Reveal>
      </div>
    </section>
  );
}
