"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BackIcon } from "@/components/icons";

const ADMIN_TABS = [
  { href: "/app/admin", label: "نمای کلی" },
  { href: "/app/admin/users", label: "کاربران" },
  { href: "/app/admin/logs", label: "رویدادهای خطا" },
  { href: "/app/admin/categories", label: "دسته‌بندی پیش‌فرض" },
] as const;

export function AdminNav() {
  const pathname = usePathname();

  return (
    <div className="sticky top-0 z-10 border-b border-border bg-surface">
      <div className="flex items-center gap-2 px-4 pt-4">
        <Link
          href="/app"
          aria-label="بازگشت به برنامه"
          className="rounded-full p-1.5 text-muted hover:bg-background hover:text-foreground"
        >
          <BackIcon className="h-5 w-5" />
        </Link>
        <h1 className="text-sm font-bold text-foreground">پنل مدیریت</h1>
      </div>
      <nav className="flex gap-1.5 overflow-x-auto px-4 pb-3 pt-3">
        {ADMIN_TABS.map(({ href, label }) => {
          const active = href === "/app/admin" ? pathname === "/app/admin" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${
                active ? "bg-primary text-on-primary" : "bg-background text-muted"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
