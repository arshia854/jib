"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HomeIcon, ListIcon, ChatIcon, TagIcon } from "@/components/icons";

const NAV_ITEMS = [
  { href: "/app", label: "خانه", Icon: HomeIcon },
  { href: "/app/transactions", label: "تراکنش‌ها", Icon: ListIcon },
  { href: "/app/chat", label: "دستیار", Icon: ChatIcon },
  { href: "/app/categories", label: "دسته‌ها", Icon: TagIcon },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]">
      <ul className="flex items-stretch justify-between">
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = href === "/app" ? pathname === "/app" : pathname.startsWith(href);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                className={`flex flex-col items-center gap-1 py-2.5 text-xs ${
                  active ? "text-primary" : "text-muted"
                }`}
              >
                <Icon className="h-6 w-6" strokeWidth={active ? 2.2 : 1.8} />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
