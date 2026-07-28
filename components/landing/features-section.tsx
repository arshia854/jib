import { Reveal } from "./reveal";
import { EditIcon, ChatIcon, ChartIcon, type IconProps } from "@/components/icons";

const TONE_CLASSES = {
  primary: "bg-primary/10 text-primary",
  accent: "bg-accent/10 text-accent",
  success: "bg-success/10 text-success",
} as const;

const FEATURES: { title: string; description: string; Icon: (props: IconProps) => React.JSX.Element; tone: keyof typeof TONE_CLASSES }[] = [
  {
    title: "ثبت تراکنش با متن آزاد",
    description: "دیگه لازم نیست فرم پر کنی؛ همون‌طور که حرف می‌زنی بنویس.",
    Icon: EditIcon,
    tone: "primary",
  },
  {
    title: "چت مالی با هوش مصنوعی",
    description: "هر سوالی درباره وضعیت مالیت داری، از دستیار جیب بپرس.",
    Icon: ChatIcon,
    tone: "accent",
  },
  {
    title: "گزارش و تحلیل هزینه‌ها",
    description: "با نمودار دسته‌بندی، ببین پولت کجا خرج می‌شه.",
    Icon: ChartIcon,
    tone: "success",
  },
];

export function FeaturesSection() {
  return (
    <section className="px-5 py-16 sm:py-24">
      <div className="mx-auto max-w-5xl">
        <Reveal className="text-center">
          <h2 className="text-2xl font-bold text-foreground sm:text-3xl">همه‌چی برای مدیریت پولت</h2>
          <p className="mt-3 text-sm text-muted sm:text-base">ابزارهایی که واقعاً استفاده می‌کنی</p>
        </Reveal>

        <div className="mt-12 grid gap-5 sm:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <Reveal key={feature.title} delay={i * 120}>
              <div className="h-full rounded-2xl border border-border bg-surface p-6 transition-shadow hover:shadow-lg">
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${TONE_CLASSES[feature.tone]}`}>
                  <feature.Icon className="h-6 w-6" />
                </div>
                <h3 className="mt-4 text-base font-semibold text-foreground">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{feature.description}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
