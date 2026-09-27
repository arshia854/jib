import Link from "next/link";
import { Reveal } from "./reveal";
import { BackIcon } from "@/components/icons";

export function FinalCtaSection() {
  return (
    <section className="px-5 pb-20 sm:pb-28">
      <Reveal className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl bg-gradient-to-br from-primary to-primary-soft px-6 py-14 text-center shadow-2xl shadow-primary/20 sm:px-12 sm:py-20">
        <div
          aria-hidden
          className="pointer-events-none absolute -end-16 -top-16 h-56 w-56 rounded-full border-[36px] border-on-primary/5"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-24 -start-20 h-72 w-72 rounded-full border-[44px] border-on-primary/5"
        />

        <div className="relative">
          <h2 className="text-3xl font-extrabold leading-snug text-on-primary sm:text-5xl sm:leading-snug">
            همین امروز شروع کن
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-on-primary/75 sm:text-lg sm:leading-relaxed">
            نصب و شروع کارت با جیب کمتر از یک دقیقه طول می‌کشه؛ نیازی به کارت بانکی یا اطلاعات اضافه نیست.
          </p>
          {/* bg-on-primary/text-primary (black/gold in both themes) - the old
              bg-background/text-primary pairing turned gold-on-white, near
              unreadable, under the light theme. */}
          <Link
            href="/login"
            className="group mt-9 inline-flex items-center gap-2 rounded-2xl bg-on-primary px-10 py-4 text-sm font-bold text-primary shadow-xl transition-transform active:scale-95"
          >
            رایگان شروع کن
            <BackIcon className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
          </Link>
        </div>
      </Reveal>
    </section>
  );
}
