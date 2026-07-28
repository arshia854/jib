import Link from "next/link";
import { WalletIcon } from "@/components/icons";

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-white">
            <WalletIcon className="h-4 w-4" />
          </div>
          <span className="text-base font-bold text-foreground">جیب</span>
        </div>
        <Link
          href="/login"
          className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white transition-transform active:scale-95"
        >
          ورود / ثبت‌نام
        </Link>
      </div>
    </header>
  );
}
