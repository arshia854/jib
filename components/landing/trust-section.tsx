import { Reveal } from "./reveal";
import { ShieldIcon } from "@/components/icons";

export function TrustSection() {
  return (
    <section className="bg-surface px-5 py-16 sm:py-20">
      <Reveal className="mx-auto flex max-w-3xl flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <ShieldIcon className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-bold text-foreground sm:text-2xl">اطلاعات مالیت پیش خودت می‌مونه</h2>
        <p className="text-sm leading-relaxed text-muted sm:text-base">
          جیب اطلاعات مالی تو رو با هیچ شخص یا شرکت ثالثی به اشتراک نمی‌ذاره. داده‌هات فقط برای
          نمایش گزارش‌های خودت و پاسخ به سوال‌هات از دستیار هوش مصنوعی استفاده می‌شه.
        </p>
      </Reveal>
    </section>
  );
}
