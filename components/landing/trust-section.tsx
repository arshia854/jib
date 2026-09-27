import { Reveal } from "./reveal";
import { SectionHeading } from "./section-heading";
import { ShieldIcon, LockIcon, WalletIcon, type IconProps } from "@/components/icons";

// Each point is a claim this page already made before this layout existed
// (the old single-paragraph trust copy, plus final-cta-section.tsx's "no
// bank card" line) - split into cards, not new promises.
const TRUST_POINTS: { title: string; description: string; Icon: (props: IconProps) => React.JSX.Element }[] = [
  {
    title: "به هیچ‌کس داده نمی‌شه",
    description: "جیب اطلاعات مالیت رو با هیچ شخص یا شرکت ثالثی به اشتراک نمی‌ذاره.",
    Icon: ShieldIcon,
  },
  {
    title: "فقط برای خودت",
    description: "داده‌هات فقط برای نمایش گزارش‌های خودت و پاسخ به سوال‌هات از دستیار هوش مصنوعی استفاده می‌شه.",
    Icon: LockIcon,
  },
  {
    title: "بدون کارت بانکی",
    description: "برای شروع نه کارت بانکی لازمه، نه اطلاعات اضافه.",
    Icon: WalletIcon,
  },
];

export function TrustSection() {
  return (
    <section aria-labelledby="trust-title" className="bg-surface px-5 py-20 sm:py-28">
      <div className="mx-auto max-w-5xl">
        <SectionHeading id="trust-title" eyebrow="حریم خصوصی" title="اطلاعات مالیت پیش خودت می‌مونه" />

        <div className="mt-14 grid gap-4 sm:grid-cols-3 sm:gap-5">
          {TRUST_POINTS.map((point, i) => (
            <Reveal key={point.title} delay={i * 100} className="h-full">
              <div className="h-full rounded-3xl border border-border bg-background p-6 text-center sm:p-7">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-on-primary">
                  <point.Icon className="h-6 w-6" />
                </div>
                <h3 className="mt-5 text-base font-bold text-foreground">{point.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{point.description}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
