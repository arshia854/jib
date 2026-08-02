import Link from "next/link";
import { Logo } from "@/components/logo";

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
        <Link href="/" aria-label="جیب" className="flex items-center">
          <Logo className="h-9 w-9 sm:h-10 sm:w-10" />
        </Link>
        <Link
          href="/login"
          className="rounded-xl bg-primary-darker px-4 py-2 text-xs font-semibold text-white transition-transform active:scale-95"
        >
          ورود / ثبت‌نام
        </Link>
      </div>
    </header>
  );
}
