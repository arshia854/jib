"use client";

import { useEffect, useRef, useState } from "react";
import { Reveal } from "./reveal";
import { SectionHeading } from "./section-heading";
import { EditIcon, MailIcon, TagIcon, ChatIcon, ChartIcon, TargetIcon, type IconProps } from "@/components/icons";
import { formatNumber } from "@/lib/format";

// Six real, existing capabilities (free-text/SMS parsing, categorization, AI
// chat, reports, goal feasibility) - not invented features. This list
// absorbed the former feature-walkthrough section's six items, which
// repeated this section's own cards word for word; copy is reused verbatim
// from those two sources, informal/تو-voice per docs/jib-persona.md.
const FEATURES: { title: string; description: string; Icon: (props: IconProps) => React.JSX.Element }[] = [
  {
    title: "ثبت با یک جمله",
    description: "هر خرجی رو با یه جمله ساده بنویس، جیب خودش می‌فهمه.",
    Icon: EditIcon,
  },
  {
    title: "تشخیص از پیامک بانک",
    description: "پیامک بانکت رو بفرست، جیب مبلغ و نوع تراکنش رو خودش تشخیص می‌ده.",
    Icon: MailIcon,
  },
  {
    title: "دسته‌بندی هوشمند",
    description: "دیگه لازم نیست فرم پر کنی؛ هر تراکنش خودش دسته‌بندیش رو پیدا می‌کنه.",
    Icon: TagIcon,
  },
  {
    title: "چت مالی با هوش مصنوعی",
    description: "هر سوالی درباره وضعیت مالیت داری، از دستیار جیب بپرس.",
    Icon: ChatIcon,
  },
  {
    title: "گزارش و تحلیل هزینه‌ها",
    description: "با نمودار دسته‌بندی، ببین پولت کجا خرج می‌شه.",
    Icon: ChartIcon,
  },
  {
    title: "هدف‌گذاری مالی",
    description: "هدف بذار، جیب بهت می‌گه شدنیه یا نه - و کمکت می‌کنه بهش برسی.",
    Icon: TargetIcon,
  },
];

export function FeaturesSection() {
  const [active, setActive] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    // Only relevant on the mobile carousel layout below (the sm:grid
    // layout has no meaningful "active card" and just never shows the dots
    // that read this state) - tracks whichever card is most visible inside
    // the scroll container, rather than assuming an LTR scrollLeft sign
    // convention that RTL browsers don't share.
    const observer = new IntersectionObserver(
      (entries) => {
        let best: IntersectionObserverEntry | null = null;
        for (const entry of entries) {
          if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
        }
        if (best && best.intersectionRatio > 0.5) {
          const index = cardRefs.current.findIndex((el) => el === best!.target);
          if (index !== -1) setActive(index);
        }
      },
      { root: track, threshold: [0.5, 0.75, 1] }
    );
    cardRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  function goTo(index: number) {
    cardRefs.current[index]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }

  return (
    <section id="features" aria-labelledby="features-title" className="scroll-mt-16 px-5 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          id="features-title"
          eyebrow="امکانات"
          title="همه‌چی برای مدیریت پولت"
          description="ابزارهایی که واقعاً استفاده می‌کنی"
        />

        {/* Mobile: a swipeable, scroll-snap carousel (one card per view).
            sm and up: reverts to a plain grid, where swipe/dots don't apply. */}
        <div
          ref={trackRef}
          className="mt-14 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 [scrollbar-width:none] sm:grid sm:grid-cols-2 sm:gap-5 sm:overflow-visible lg:grid-cols-3 [&::-webkit-scrollbar]:hidden"
        >
          {FEATURES.map((feature, i) => (
            <div
              key={feature.title}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              className="w-[85%] shrink-0 snap-center sm:w-auto sm:shrink sm:snap-none"
            >
              <Reveal delay={(i % 3) * 100} className="h-full">
                <div className="group h-full rounded-3xl border border-border bg-surface p-6 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-xl sm:p-7">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-foreground ring-1 ring-inset ring-primary/25 transition-colors duration-300 group-hover:bg-primary group-hover:text-on-primary">
                    <feature.Icon className="h-6 w-6" />
                  </div>
                  <h3 className="mt-5 text-lg font-bold text-foreground">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{feature.description}</p>
                </div>
              </Reveal>
            </div>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-center gap-3 sm:hidden">
          <div className="flex items-center gap-1.5">
            {FEATURES.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`ویژگی ${formatNumber(i + 1)}`}
                aria-current={i === active}
                className={`h-1.5 rounded-full transition-all ${i === active ? "w-5 bg-primary" : "w-1.5 bg-border"}`}
              />
            ))}
          </div>
          <span className="text-xs text-muted">
            {formatNumber(active + 1)} از {formatNumber(FEATURES.length)}
          </span>
        </div>
      </div>
    </section>
  );
}
