import Link from "next/link";
import { Reveal } from "./reveal";
import { SectionHeading } from "./section-heading";
import { CheckIcon } from "@/components/icons";
import { formatNumber } from "@/lib/format";

// PLACEHOLDER PRICING - no pricing model (prices, trial length, usage caps,
// plan names, or which features sit in which tier) exists anywhere in this
// codebase or docs yet (searched 2026-09-25). Every number below is `null`
// and renders as a literal "X" on the page until a real figure is decided;
// replace it with a plain number (e.g. `paidMonthlyToman: 99000`) and it
// goes through formatNumber() like every other amount on this page. Plan
// names and the per-tier feature split are likewise proposals, not
// confirmed product decisions - every feature listed is a real, existing
// capability, but which tier it belongs to is not decided.
const PRICING: {
  trialDays: number | null;
  paidMonthlyToman: number | null;
  freeChatMessagesPerMonth: number | null;
  paidChatMessagesPerMonth: number | null;
} = {
  trialDays: null,
  paidMonthlyToman: null,
  freeChatMessagesPerMonth: null,
  paidChatMessagesPerMonth: null,
};

function valueOrPlaceholder(value: number | null): string {
  return value === null ? "X" : formatNumber(value);
}

type PlanPrice =
  | { kind: "free" }
  | { kind: "trial"; days: number | null }
  | { kind: "paid"; monthlyToman: number | null };

interface Plan {
  name: string;
  description: string;
  price: PlanPrice;
  features: string[];
  cta: string;
  featured?: boolean;
}

// No checkout/payment flow exists yet, so every CTA leads to the same
// /login signup as the rest of this page.
const PLANS: Plan[] = [
  {
    name: "پایه",
    description: "برای شروع و آشنایی با جیب",
    price: { kind: "free" },
    features: [
      "ثبت تراکنش با یک جمله یا پیامک بانک",
      "دسته‌بندی هوشمند خودکار",
      "گزارش و نمودار هزینه‌ها",
      `تا ${valueOrPlaceholder(PRICING.freeChatMessagesPerMonth)} پیام در ماه با دستیار هوش مصنوعی`,
    ],
    cta: "رایگان شروع کن",
  },
  {
    name: "آزمایشی",
    description: "همه امکانات ویژه رو قبل از خرید امتحان کن",
    price: { kind: "trial", days: PRICING.trialDays },
    features: [
      "دسترسی کامل به همه امکانات پلن ویژه",
      "هدف‌گذاری، گزارش‌های مقایسه‌ای و مدیریت دارایی‌ها",
    ],
    cta: "شروع دوره آزمایشی",
    featured: true,
  },
  {
    name: "ویژه",
    description: "برای وقتی جیب شد همراه هر روزه",
    price: { kind: "paid", monthlyToman: PRICING.paidMonthlyToman },
    features: [
      "همه امکانات پلن پایه",
      `تا ${valueOrPlaceholder(PRICING.paidChatMessagesPerMonth)} پیام در ماه با دستیار هوش مصنوعی`,
      "هدف‌گذاری مالی و استراتژی پس‌انداز",
      "گزارش‌های مقایسه‌ای و روند خرج",
      "مدیریت دارایی‌ها با قیمت لحظه‌ای طلا و ارز",
    ],
    cta: "انتخاب پلن ویژه",
  },
];

function PlanPriceDisplay({ price }: { price: PlanPrice }) {
  if (price.kind === "free") {
    return <p className="text-4xl font-extrabold text-foreground">رایگان</p>;
  }
  const [amount, suffix] =
    price.kind === "trial"
      ? [valueOrPlaceholder(price.days), "روز رایگان"]
      : [valueOrPlaceholder(price.monthlyToman), "تومان در ماه"];
  return (
    <p className="flex items-baseline gap-2">
      <span className="tabular-fa text-4xl font-extrabold text-foreground">{amount}</span>
      <span className="text-sm font-medium text-muted">{suffix}</span>
    </p>
  );
}

export function PricingSection() {
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-16 px-5 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          id="pricing-title"
          eyebrow="تعرفه‌ها"
          title="رایگان شروع کن، هر وقت لازم شد ارتقا بده"
          description="برای شروع هزینه‌ای لازم نیست؛ هر وقت امکانات بیشتری خواستی، سراغ پلن ویژه برو."
        />

        <div className="mx-auto mt-14 grid max-w-md gap-6 lg:max-w-none lg:grid-cols-3 lg:gap-5">
          {PLANS.map((plan, i) => (
            <Reveal key={plan.name} delay={i * 100} className="h-full">
              <div
                className={`relative flex h-full flex-col rounded-3xl border p-7 ${
                  plan.featured
                    ? "border-primary bg-primary-bg shadow-2xl shadow-primary/15 ring-1 ring-primary"
                    : "border-border bg-surface"
                }`}
              >
                {plan.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-xs font-bold text-on-primary shadow-md">
                    پیشنهادی
                  </span>
                )}

                <h3 className="text-lg font-bold text-foreground">{plan.name}</h3>
                <p className="mt-1.5 text-sm text-muted">{plan.description}</p>

                <div className="mt-6">
                  <PlanPriceDisplay price={plan.price} />
                </div>

                <ul className="mt-6 space-y-3 border-t border-border pt-6">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5 text-sm leading-relaxed text-foreground">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
                        <CheckIcon className="h-3 w-3" />
                      </span>
                      {feature}
                    </li>
                  ))}
                </ul>

                {/* mt-auto pins the CTA to the card bottom so all three line up
                    across unequal feature lists; pt-8 keeps a gap in the tallest. */}
                <div className="mt-auto pt-8">
                  <Link
                    href="/login"
                    className={`block rounded-2xl px-6 py-3.5 text-center text-sm font-bold transition-transform active:scale-95 ${
                      plan.featured
                        ? "bg-primary text-on-primary shadow-lg shadow-primary/25"
                        : "border border-border bg-background text-foreground hover:bg-foreground/5"
                    }`}
                  >
                    {plan.cta}
                  </Link>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
