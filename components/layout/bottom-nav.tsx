"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HomeIcon, WalletIcon, ChartIcon, SparklesIcon, SettingsIcon } from "@/components/icons";

const NAV_ITEMS = [
  { href: "/app", label: "خانه", Icon: HomeIcon },
  { href: "/app/dashboard", label: "داشبورد", Icon: WalletIcon },
  { href: "/app/reports", label: "گزارش‌ها", Icon: ChartIcon },
  { href: "/app/chat", label: "دستیار", Icon: SparklesIcon },
  { href: "/app/settings", label: "تنظیمات", Icon: SettingsIcon },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  const activeIndex = NAV_ITEMS.findIndex(({ href }) =>
    href === "/app" ? pathname === "/app" : pathname.startsWith(href),
  );

  return (
    <nav className="shrink-0 px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <ul className="relative grid grid-cols-5 rounded-[26px] border border-border/70 bg-surface/85 shadow-[0_8px_24px_-6px_rgba(255,255,255,0.06)] backdrop-blur-xl">
        {activeIndex >= 0 && (
          <li
            aria-hidden
            className="pointer-events-none absolute inset-y-1.5 z-0 rounded-[19px] bg-primary transition-[inset-inline-start] duration-300 ease-out"
            style={{
              width: `${100 / NAV_ITEMS.length}%`,
              insetInlineStart: `${(activeIndex * 100) / NAV_ITEMS.length}%`,
            }}
          />
        )}
        {NAV_ITEMS.map(({ href, label, Icon }, index) => {
          const active = index === activeIndex;
          return (
            <li key={href} className="relative z-10">
              <Link
                href={href}
                className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] transition-colors ${
                  active ? "font-medium text-on-primary" : "text-muted"
                }`}
              >
                <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.5} />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
