import { Reveal } from "./reveal";
import { ChatIcon, SparklesIcon, ChartIcon } from "@/components/icons";

const STEPS = [
  {
    title: "پیامکت رو بفرست",
    description: "یه جمله ساده بنویس یا پیامک بانکت رو کپی‌پیست کن.",
    Icon: ChatIcon,
  },
  {
    title: "هوش مصنوعی دسته‌بندی می‌کنه",
    description: "جیب مبلغ، نوع و دسته‌بندی تراکنش رو خودش تشخیص می‌ده.",
    Icon: SparklesIcon,
  },
  {
    title: "خرجت رو ببین و کنترلش کن",
    description: "با نمودار و گزارش‌های ساده، وضعیت مالیت رو همیشه زیر نظر داشته باش.",
    Icon: ChartIcon,
  },
];

export function HowItWorksSection() {
  return (
    <section id="how-it-works" className="bg-surface px-5 py-16 sm:py-24">
      <div className="mx-auto max-w-5xl">
        <Reveal className="text-center">
          <h2 className="text-2xl font-bold text-foreground sm:text-3xl">چطور کار می‌کنه؟</h2>
          <p className="mt-3 text-sm text-muted sm:text-base">سه قدم ساده تا کنترل کامل مالی</p>
        </Reveal>

        <div className="relative mt-12 grid gap-10 sm:grid-cols-3 sm:gap-6">
          <div className="absolute top-8 hidden h-px w-full bg-border sm:block" aria-hidden />
          {STEPS.map((step, i) => (
            <Reveal key={step.title} delay={i * 120} className="relative text-center">
              <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-background ring-4 ring-surface">
                <step.Icon className="h-7 w-7 text-primary-dark" />
                <span className="absolute -top-2 -end-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-on-primary">
                  {i + 1}
                </span>
              </div>
              <h3 className="mt-5 text-base font-semibold text-foreground">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{step.description}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
