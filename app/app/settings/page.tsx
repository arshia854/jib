import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth/session";
import { LogoutButton } from "@/components/layout/logout-button";
import { AssetDisplayToggle } from "@/components/settings/asset-display-toggle";
import { ThemeToggle } from "@/components/settings/theme-toggle";
import { THEME_COOKIE, isThemePreference } from "@/lib/theme";
import { TagIcon, WalletIcon, ShieldIcon, BackIcon, UserIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

// "دارایی‌ها" moved to the داشبورد tab (app/app/dashboard/page.tsx?tab=assets)
// in Phase 3 - no longer reachable from here.
const ROWS = [
  { href: "/app/settings/profile", label: "اطلاعات شخصی", Icon: UserIcon },
  { href: "/app/settings/categories", label: "دسته‌بندی‌ها", Icon: TagIcon },
  { href: "/app/settings/accounts", label: "حساب‌ها", Icon: WalletIcon },
] as const;

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const rows = user.role === "admin" ? [...ROWS, { href: "/app/admin", label: "پنل مدیریت", Icon: ShieldIcon }] : ROWS;

  const store = await cookies();
  const cookieValue = store.get(THEME_COOKIE)?.value;
  const initialPreference = isThemePreference(cookieValue) ? cookieValue : "system";

  return (
    <div className="space-y-6 px-4 pb-8 pt-6">
      <header>
        <h1 className="text-lg font-bold text-foreground">تنظیمات</h1>
      </header>

      <section className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-bold text-primary-dark">
          {(user.name ?? "ک").charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{user.name ?? "کاربر جیب"}</p>
          <p dir="ltr" className="text-left text-xs text-muted">
            {user.phoneNumber}
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-surface px-4">
        {rows.map(({ href, label, Icon }, i) => (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-3 py-3.5 ${i > 0 ? "border-t border-border" : ""}`}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-background text-muted">
              <Icon className="h-5 w-5" />
            </div>
            <span className="flex-1 text-sm font-medium text-foreground">{label}</span>
            <BackIcon className="h-4 w-4 rotate-180 text-muted" />
          </Link>
        ))}
      </section>

      <section className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4">
        <div>
          <p className="text-sm font-medium text-foreground">نمایش دارایی در داشبورد</p>
          <p className="mt-0.5 text-xs text-muted">موجودی کل رو معادل گرم طلا و دلار هم نشون بده.</p>
        </div>
        <AssetDisplayToggle initialEnabled={user.showBalanceInAssets} />
      </section>

      <section className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4">
        <div>
          <p className="text-sm font-medium text-foreground">ظاهر برنامه</p>
          <p className="mt-0.5 text-xs text-muted">روشن، تاریک یا هماهنگ با سیستم.</p>
        </div>
        <ThemeToggle initialPreference={initialPreference} />
      </section>

      <section className="flex items-center justify-between rounded-2xl border border-border bg-surface p-4">
        <p className="text-sm font-medium text-foreground">خروج از حساب</p>
        <LogoutButton />
      </section>
    </div>
  );
}
