import Link from "next/link";
import { Reveal } from "./reveal";

export function FinalCtaSection() {
  return (
    <section className="px-5 py-16 sm:py-24">
      <Reveal className="mx-auto max-w-3xl overflow-hidden rounded-3xl bg-gradient-to-br from-primary to-primary-soft px-6 py-12 text-center shadow-xl sm:px-12 sm:py-16">
        <h2 className="text-2xl font-bold text-on-primary sm:text-3xl">همین امروز شروع کن</h2>
        <p className="mt-3 text-sm leading-relaxed text-on-primary/80 sm:text-base">
          نصب و شروع کارت با جیب کمتر از یک دقیقه طول می‌کشه؛ نیازی به کارت بانکی یا اطلاعات اضافه نیست.
        </p>
        <Link
          href="/login"
          className="mt-7 inline-block rounded-2xl bg-background px-10 py-3.5 text-sm font-semibold text-primary shadow-lg transition-transform active:scale-95"
        >
          شروع کن
        </Link>
      </Reveal>
    </section>
  );
}
