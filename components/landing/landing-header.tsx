import Link from "next/link";
import { Logo } from "@/components/logo";

// In-page anchors shared by the header nav and the footer - each href must
// match an `id` on a section in app/page.tsx's flow.
export const LANDING_NAV_LINKS = [
  { href: "#how-it-works", label: "چطور کار می‌کنه" },
  { href: "#features", label: "امکانات" },
  { href: "#pricing", label: "تعرفه‌ها" },
];

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-5 py-3">
        <Link href="/" aria-label="جیب" className="flex items-center gap-2.5">
          <Logo className="h-9 w-9 sm:h-10 sm:w-10" />
          <span aria-hidden className="text-lg font-extrabold text-foreground">
            جیب
          </span>
        </Link>

        <nav aria-label="بخش‌های صفحه" className="hidden items-center gap-1 md:flex">
          {LANDING_NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <Link
          href="/login"
          className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-on-primary transition-transform active:scale-95 sm:text-sm"
        >
          ورود / ثبت‌نام
        </Link>
      </div>
    </header>
  );
}
