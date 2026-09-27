import { toJalaali } from "jalaali-js";
import { Logo } from "@/components/logo";
import { LANDING_NAV_LINKS } from "./landing-header";
import { formatJalaaliYear } from "@/lib/format";

export function LandingFooter() {
  const { jy } = toJalaali(new Date());

  return (
    <footer className="border-t border-border px-5 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 sm:flex-row sm:justify-between">
        <div className="flex items-center gap-3">
          <Logo className="h-10 w-10" />
          <div>
            <p className="text-base font-extrabold text-foreground">جیب</p>
            <p className="text-xs text-muted">دستیار مالی هوشمند فارسی</p>
          </div>
        </div>

        <nav aria-label="پیوندهای پایین صفحه" className="flex flex-wrap items-center justify-center gap-1">
          {LANDING_NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>

      <p className="mx-auto mt-8 max-w-6xl border-t border-border pt-6 text-center text-xs text-muted sm:text-start">
        © {formatJalaaliYear(jy)} جیب · ساخته‌شده برای بازار ایران
      </p>
    </footer>
  );
}
