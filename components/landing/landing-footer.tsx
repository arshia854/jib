import { toJalaali } from "jalaali-js";

export function LandingFooter() {
  const { jy } = toJalaali(new Date());
  const year = new Intl.NumberFormat("fa-IR").format(jy);

  return (
    <footer className="border-t border-border px-5 py-8">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-2 text-center">
        <span className="text-sm font-bold text-foreground">جیب</span>
        <p className="text-xs text-muted">دستیار مالی هوشمند شما · ساخته‌شده برای بازار ایران</p>
        <p className="mt-2 text-[11px] text-muted">© {year} جیب</p>
      </div>
    </footer>
  );
}
